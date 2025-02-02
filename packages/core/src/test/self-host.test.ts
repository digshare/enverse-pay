import {assertScriptsCompleted, call, createBlackObject, x} from 'black-object';
import _ from 'lodash';
import {MongoClient} from 'mongodb';
import {MongoMemoryServer} from 'mongodb-memory-server';
import ms from 'ms';

import type {IPayingService, IProduct} from '../library';
import {Paying, ProductId, Timestamp, UserId} from '../library';

import {
  dbName,
  generateOriginalTransactionId,
  generateTransactionId,
} from './@common';

let GROUP_PRODUCTS: Record<
  'monthly' | 'yearly',
  Required<IProduct> & {duration: number}
> = {
  monthly: {
    group: 'membership',
    id: 'monthly' as ProductId,
    duration: ms('1m'),
    type: 'subscription',
  },
  yearly: {
    group: 'membership',
    id: 'yearly' as ProductId,
    duration: ms('1y'),
    type: 'subscription',
  },
};

let PURCHASE_PRODUCTS: Record<'product-a' | 'product-b', IProduct> = {
  'product-a': {
    id: 'product-a' as ProductId,
    type: 'purchase',
  },
  'product-b': {
    id: 'product-b' as ProductId,
    type: 'purchase',
  },
};

let mongoClient: MongoClient;
let mongoServer: MongoMemoryServer;

beforeEach(async () => {
  await mongoClient.db(dbName).dropDatabase();
});

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  mongoClient = await MongoClient.connect(mongoServer.getUri(), {
    ignoreUndefined: true,
  });

  await mongoClient.connect();
  await mongoClient.db(dbName).dropDatabase();
});

afterAll(async () => {
  await mongoClient.close();

  if (mongoServer) {
    await mongoServer.stop();
  }
});

test('should subscribed', async () => {
  let duration = ms('30d');
  let transactionId = generateTransactionId();
  let originalTransactionId = generateOriginalTransactionId();

  let selfHostedService = createBlackObject<IPayingService>([
    ['requireProduct', call([ProductId], GROUP_PRODUCTS.monthly)],
    [
      'prepareSubscriptionData',
      call(
        [
          x.object({
            startsAt: Timestamp,
            product: x.object({
              id: ProductId,
              group: x.union(x.string, x.undefined),
              type: x.union(x.literal('subscription'), x.literal('purchase')),
            }),
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          duration,
          transactionId,
          originalTransactionId,
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        [x.object({})],
        Promise.resolve({
          type: 'payment-confirmed' as 'payment-confirmed',
          transactionId,
          purchasedAt: (Date.now() + ms('2s')) as Timestamp,
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        [x.object({})],
        Promise.resolve({
          type: 'subscribed' as 'subscribed',
          originalTransactionId,
          subscribedAt: (Date.now() + ms('4s')) as Timestamp,
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        [x.object({})],
        Promise.resolve({
          type: 'payment-confirmed' as 'payment-confirmed',
          transactionId,
          purchasedAt: (Date.now() + ms('2s')) as Timestamp,
        }),
      ),
    ],
  ]);

  const paying = new Paying(
    {'self-hosted': selfHostedService},
    {
      purchaseExpiresAfter: ms('10m'),
      renewalBefore: ms('5d'),
      repository: {
        mongoClient,
        database: dbName,
      },
    },
  );

  await paying.ready;

  let {subscription} = await paying.prepareSubscription('self-hosted', {
    productId: GROUP_PRODUCTS.monthly.id,
    userId: 'xiaoming' as UserId,
  });

  expect(subscription.transactions.length).toBe(1);

  let transaction = _.first(subscription.transactions)!;

  expect(transaction.startsAt).toBeLessThan(Date.now());
  expect(transaction.canceledAt).toBeUndefined();
  expect(transaction.completedAt).toBeUndefined();
  expect(transaction.duration).toBe(duration);

  await paying.handleCallback('self-hosted', {});
  await paying.handleCallback('self-hosted', {});
  // 测试幂等
  await expect(paying.handleCallback('self-hosted', {})).rejects.toThrowError();

  await subscription.refresh();

  expect(subscription.status).toEqual('active');
  expect(subscription.renewalEnabled).toBe(true);

  assertScriptsCompleted(selfHostedService);
});

test('expired transaction should be canceled', async () => {
  let duration = ms('30d');
  let now = Date.now() as Timestamp;
  let purchaseExpiresAfter = ms('2s');
  let transactionId = generateTransactionId();
  let originalTransactionId = generateOriginalTransactionId();

  let selfHostedService = createBlackObject<IPayingService>([
    ['requireProduct', call([ProductId], GROUP_PRODUCTS.monthly)],
    [
      'prepareSubscriptionData',
      call(
        [
          x.object({
            startsAt: Timestamp,
            product: x.object({
              id: ProductId,
              group: x.union(x.string, x.undefined),
              type: x.union(x.literal('subscription'), x.literal('purchase')),
            }),
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          duration,
          transactionId,
          originalTransactionId,
        }),
      ),
    ],
    [
      'queryTransactionStatus',
      call(
        [x.string],
        Promise.resolve({
          type: 'canceled' as 'canceled',
          canceledAt: (now + purchaseExpiresAfter) as Timestamp,
        }),
      ),
    ],
  ]);

  const paying = new Paying(
    {'self-hosted': selfHostedService},
    {
      purchaseExpiresAfter,
      renewalBefore: ms('5d'),
      repository: {
        mongoClient,
        database: dbName,
      },
    },
  );

  await paying.ready;

  await paying.prepareSubscription('self-hosted', {
    productId: GROUP_PRODUCTS.monthly.id,
    userId: 'xiaoming' as UserId,
  });

  await paying.checkTransactions('self-hosted');

  let transaction = await paying.getTransaction('self-hosted', transactionId);

  expect(transaction).not.toBeUndefined();

  // TODO: subscription should be canceled too
  expect(transaction!.status).toEqual('canceled');

  assertScriptsCompleted(selfHostedService);
});

test('should renew', async () => {
  let duration = ms('1d');
  let now = Date.now() as Timestamp;
  let purchaseExpiresAfter = ms('10m');
  let transactionId = generateTransactionId();
  let originalTransactionId = generateOriginalTransactionId();
  let product = GROUP_PRODUCTS.monthly;

  let selfHostedService = createBlackObject<IPayingService>([
    [
      'prepareSubscriptionData',
      call(
        [
          x.object({
            startsAt: Timestamp,
            product: x.object({
              id: ProductId,
              group: x.union(x.string, x.undefined),
              type: x.union(x.literal('subscription'), x.literal('purchase')),
            }),
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          duration,
          transactionId,
          originalTransactionId,
        }),
      ),
    ],
    [
      'queryTransactionStatus',
      call(
        [x.string],
        Promise.resolve({
          type: 'success' as 'success',
          purchasedAt: (now + ms('2s')) as Timestamp,
        }),
      ),
    ],
    [
      'querySubscriptionStatus',
      call(
        [x.string],
        Promise.resolve({
          type: 'subscribed' as 'subscribed',
          originalTransactionId,
          subscribedAt: (Date.now() + ms('4s')) as Timestamp,
        }),
      ),
    ],
    [
      'rechargeSubscription',
      call(
        [x.object({}), Timestamp],
        Promise.resolve({
          type: 'subscription-renewal' as 'subscription-renewal',
          transactionId: generateTransactionId(),
          purchasedAt: (now + ms('2s')) as Timestamp,
          duration,
          originalTransactionId,
          product,
        }),
      ),
    ],
    [
      'rechargeSubscription',
      call(
        [x.object({}), Timestamp],
        Promise.resolve({
          type: 'subscription-renewal' as 'subscription-renewal',
          transactionId: generateTransactionId(),
          purchasedAt: (now + ms('2s')) as Timestamp,
          duration,
          originalTransactionId,
          product,
        }),
      ),
    ],
    [
      'rechargeSubscription',
      call(
        [x.object({}), x.number],
        Promise.resolve({
          type: 'recharge-failed' as 'recharge-failed',
          originalTransactionId,
          failedAt: (now + ms('2s')) as Timestamp,
          reason: '!WARNING! Somebody is snooping on this connection.',
        }),
      ),
    ],
    [
      'rechargeSubscription',
      call(
        [x.object({}), x.number],
        Promise.resolve({
          type: 'subscription-canceled' as 'subscription-canceled',
          originalTransactionId,
          canceledAt: (now + ms('10s')) as Timestamp,
          reason: '!SHIT! this connection is controlled by snooper.',
        }),
      ),
    ],
  ]);

  const paying = new Paying(
    {'self-hosted': selfHostedService},
    {
      purchaseExpiresAfter,
      renewalBefore: ms('5d'),
      repository: {
        mongoClient,
        database: dbName,
      },
    },
  );

  await paying.ready;

  let {subscription} = await paying.prepareSubscription('self-hosted', {
    productId: product.id,
    userId: 'xiaoming' as UserId,
  });

  // 确认付款

  await paying.checkTransactions('self-hosted');

  let transaction = await paying.getTransaction('self-hosted', transactionId);

  expect(transaction).not.toBeUndefined();

  await subscription.refresh();

  expect(subscription.status).toEqual('active');
  expect(subscription.expiresAt).toEqual(subscription.startsAt! + duration);

  await paying.checkUncompletedSubscription('self-hosted', error => {
    throw error;
  });

  // 第一次续费
  await paying.checkSubscriptionRenewal('self-hosted', error => {
    throw error;
  });

  await subscription.refresh();

  expect(subscription.expiresAt).toEqual(
    (subscription.startsAt! + duration * 2) as Timestamp,
  );

  // 第二次续费
  await paying.checkSubscriptionRenewal('self-hosted', error => {
    throw error;
  });

  await subscription.refresh();

  expect(subscription.expiresAt).toEqual(
    (subscription.startsAt! + duration * 3) as Timestamp,
  );

  // 第三次续费失败
  await paying.checkSubscriptionRenewal('self-hosted', error => {
    throw error;
  });

  await subscription.refresh();

  expect({}).toMatchInlineSnapshot(`Object {}`);

  expect(subscription.originalTransaction.lastFailedAt).not.toBeUndefined();

  // 第四次续费发现订阅取消
  await paying.checkSubscriptionRenewal('self-hosted', error => {
    throw error;
  });

  await subscription.refresh();

  expect(await subscription.renewalEnabled).toBe(false);
  expect(await subscription.originalTransaction.canceledAt).toBe(
    now + ms('10s'),
  );

  assertScriptsCompleted(selfHostedService);
});

test('should change subscription', async () => {
  let now = Date.now() as Timestamp;
  let purchaseExpiresAfter = ms('10m');
  let monthlyProduct = GROUP_PRODUCTS['monthly'];
  let yearlyProduct = GROUP_PRODUCTS['yearly'];
  let userId = 'xiaoming' as UserId;

  let selfHostedService = createBlackObject<IPayingService>([
    [
      'prepareSubscriptionData',
      call(
        // TODO: fix any
        [
          x.object({
            startsAt: Timestamp,
            product: x.object({
              id: ProductId,
              group: x.union(x.string, x.undefined),
              type: x.union(x.literal('subscription'), x.literal('purchase')),
            }),
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          duration: monthlyProduct.duration,
          transactionId: generateTransactionId(),
          originalTransactionId: generateOriginalTransactionId(),
        }),
      ),
    ],
    [
      'queryTransactionStatus',
      call(
        [x.string],
        Promise.resolve({
          type: 'success' as 'success',
          purchasedAt: (now + ms('2s')) as Timestamp,
        }),
      ),
    ],
    ['cancelSubscription', call([x.object({})], Promise.resolve(true))],
    [
      'prepareSubscriptionData',
      call(
        [
          x.object({
            startsAt: Timestamp,
            product: x.object({
              id: ProductId,
              group: x.union(x.string, x.undefined),
            }),
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          duration: yearlyProduct.duration,
          transactionId: generateTransactionId(),
          originalTransactionId: generateOriginalTransactionId(),
        }),
      ),
    ],
    [
      'queryTransactionStatus',
      call(
        [x.string],
        Promise.resolve({
          type: 'success' as 'success',
          purchasedAt: (now + ms('2s')) as Timestamp,
        }),
      ),
    ],
  ]);

  const paying = new Paying(
    {'self-hosted': selfHostedService},
    {
      purchaseExpiresAfter,
      renewalBefore: ms('5d'),
      repository: {
        mongoClient,
        database: dbName,
      },
    },
  );

  await paying.ready;

  let {subscription: monthlySubscription} = await paying.prepareSubscription(
    'self-hosted',
    {
      productId: monthlyProduct.id,
      userId,
    },
  );

  await paying.checkTransactions('self-hosted');

  await monthlySubscription.refresh();

  expect(monthlySubscription.status).toEqual('active');

  let {subscription: yearlySubscription} = await paying.prepareSubscription(
    'self-hosted',
    {productId: yearlyProduct.id, userId},
  );

  await monthlySubscription.refresh();

  expect(monthlySubscription.status).toEqual('canceled');
  expect(yearlySubscription.status).toEqual('pending');

  await paying.checkTransactions('self-hosted');

  await yearlySubscription.refresh();

  expect(yearlySubscription.status).toEqual('not-start');

  expect(yearlySubscription.expiresAt).toEqual(
    monthlySubscription.startsAt! +
      yearlyProduct.duration +
      monthlyProduct.duration,
  );

  expect(yearlySubscription.startsAt).toEqual(monthlySubscription.expiresAt);

  assertScriptsCompleted(selfHostedService);

  let user = await paying.user(userId);

  expect(user.getExpireTime(yearlyProduct.group)).toEqual(
    yearlySubscription.expiresAt,
  );
});

test('should subscription be canceled', async () => {
  let duration = ms('30d');
  let transactionId = generateTransactionId();
  let originalTransactionId = generateOriginalTransactionId();

  let selfHostedService = createBlackObject<IPayingService>([
    [
      'prepareSubscriptionData',
      call(
        [
          x.object({
            startsAt: Timestamp,
            product: x.object({
              id: ProductId,
              group: x.union(x.string, x.undefined),
              type: x.union(x.literal('subscription'), x.literal('purchase')),
            }),
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          duration,
          transactionId,
          originalTransactionId,
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        [x.object({})],
        Promise.resolve({
          type: 'payment-confirmed' as 'payment-confirmed',
          transactionId,
          purchasedAt: (Date.now() + ms('2s')) as Timestamp,
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        [x.object({})],
        Promise.resolve({
          type: 'subscribed' as 'subscribed',
          originalTransactionId,
          subscribedAt: (Date.now() + ms('4s')) as Timestamp,
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        [x.object({})],
        Promise.resolve({
          type: 'subscription-canceled' as 'subscription-canceled',
          originalTransactionId,
          canceledAt: (Date.now() + ms('10s')) as Timestamp,
        }),
      ),
    ],
  ]);

  const paying = new Paying(
    {'self-hosted': selfHostedService},
    {
      purchaseExpiresAfter: ms('10m'),
      renewalBefore: ms('5d'),
      repository: {
        mongoClient,
        database: dbName,
      },
    },
  );

  await paying.ready;

  let {subscription} = await paying.prepareSubscription('self-hosted', {
    productId: GROUP_PRODUCTS.monthly.id,
    userId: 'xiaoming' as UserId,
  });

  await paying.handleCallback('self-hosted', {});
  await paying.handleCallback('self-hosted', {});

  await subscription.refresh();

  expect(subscription.status).toEqual('active');
  expect(subscription.renewalEnabled).toBe(true);

  await paying.handleCallback('self-hosted', {});
  await subscription.refresh();

  expect(subscription.status).toEqual('canceled');
  expect(subscription.renewalEnabled).toBe(false);
  expect(subscription.expiresAt).toBe(subscription.startsAt! + duration);

  assertScriptsCompleted(selfHostedService);
});

test('should purchase', async () => {
  let userId = 'xiaoming' as UserId;
  let transactionId1 = generateTransactionId();
  let transactionId2 = generateTransactionId();

  let selfHostedService = createBlackObject<IPayingService>([
    [
      'preparePurchaseData',
      call(
        [
          x.object({
            productId: ProductId,
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          transactionId: transactionId1,
          product: PURCHASE_PRODUCTS['product-a'],
        }),
      ),
    ],
    [
      'queryTransactionStatus',
      call(
        [x.string],
        Promise.resolve({
          type: 'success' as 'success',
          purchasedAt: Date.now() as Timestamp,
        }),
      ),
    ],
    [
      'preparePurchaseData',
      call(
        [
          x.object({
            productId: ProductId,
            paymentExpiresAt: Timestamp,
            userId: UserId,
          }),
        ],
        Promise.resolve({
          response: '',
          transactionId: transactionId2,
          product: PURCHASE_PRODUCTS['product-a'],
        }),
      ),
    ],
    [
      'parseCallback',
      call(
        // TODO: fix any
        [x.object({})],
        Promise.resolve({
          type: 'payment-confirmed' as 'payment-confirmed',
          transactionId: transactionId2,
          purchasedAt: Date.now() as Timestamp,
        }),
      ),
    ],
  ]);

  const paying = new Paying(
    {'self-hosted': selfHostedService},
    {
      purchaseExpiresAfter: ms('10m'),
      renewalBefore: ms('5d'),
      repository: {
        mongoClient,
        database: dbName,
      },
    },
  );

  await paying.preparePurchase(
    'self-hosted',
    PURCHASE_PRODUCTS['product-a'].id,
    userId,
  );

  await paying.checkTransactions('self-hosted', error => {
    throw error;
  });

  let transaction = await paying.getTransaction('self-hosted', transactionId1);

  expect(transaction).not.toBeUndefined();

  expect(transaction?.status).toEqual('completed');

  await paying.preparePurchase(
    'self-hosted',
    PURCHASE_PRODUCTS['product-a'].id,
    userId,
  );

  await paying.handleCallback('self-hosted', {});

  let transaction2 = await paying.getTransaction('self-hosted', transactionId2);

  expect(transaction2).not.toBeUndefined();

  expect(transaction2?.status).toEqual('completed');

  let user = await paying.user(userId);

  expect(user.purchaseTransactions.length).toEqual(2);

  assertScriptsCompleted(selfHostedService);
});
