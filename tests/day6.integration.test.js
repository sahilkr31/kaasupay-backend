require("dotenv").config();

const { randomUUID } = require("crypto");
const { test } = require("node:test");
const assert = require("node:assert/strict");

const TEST_DATABASE_NAME = "kaasupay_day6_integration_test";
const MONEY_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const TEST_COLLECTIONS = Object.freeze([
  "users",
  "wallets",
  "transactions",
  "ledgerentries",
  "paymentorders",
  "bankaccounts",
  "withdrawals",
  "outboxevents",
  "dailyspends",
  "ratelimitcounters",
  "moneyrequests",
]);

test(
  "Day 6 and Day 7 API integration scenarios on an isolated MongoDB database",
  async (t) => {
    const suppliedMongoUrl = process.env.DAY6_TEST_MONGO_URL;
    const expectedTestHost = process.env.DAY6_TEST_MONGO_HOST?.trim().toLowerCase();
    const expectedApplicationHost = process.env.DAY6_APP_MONGO_HOST?.trim().toLowerCase();
    const applicationDatabaseName = process.env.DAY6_APP_MONGO_DATABASE?.trim();
    const expectedTestUsername = process.env.DAY6_TEST_MONGO_USERNAME?.trim();
    const applicationUsername = process.env.DAY6_APP_MONGO_USERNAME?.trim();

    if (!suppliedMongoUrl) {
      throw new Error("DAY6_TEST_MONGO_URL is required for integration tests.");
    }
    if (
      !expectedTestHost ||
      !expectedApplicationHost ||
      !applicationDatabaseName ||
      !expectedTestUsername ||
      !applicationUsername
    ) {
      throw new Error(
        "Set the Day 6 test and application host, database, and username configuration."
      );
    }

    let testUrl;
    try {
      testUrl = new URL(suppliedMongoUrl);
    } catch {
      throw new Error("DAY6_TEST_MONGO_URL must be a valid MongoDB URL.");
    }

    if (!["mongodb:", "mongodb+srv:"].includes(testUrl.protocol)) {
      throw new Error("DAY6_TEST_MONGO_URL must use mongodb:// or mongodb+srv://.");
    }

    if (
      testUrl.hostname.toLowerCase() !== expectedTestHost ||
      expectedTestHost !== expectedApplicationHost
    ) {
      throw new Error("MongoDB hostname does not match the explicitly approved cluster configuration.");
    }
    let suppliedDatabaseName;
    try {
      suppliedDatabaseName = decodeURIComponent(testUrl.pathname.slice(1));
    } catch {
      throw new Error("DAY6_TEST_MONGO_URL contains an invalid database name.");
    }
    if (
      suppliedDatabaseName !== TEST_DATABASE_NAME ||
      suppliedDatabaseName === applicationDatabaseName
    ) {
      throw new Error("DAY6_TEST_MONGO_URL must target the fixed Day 6 test database.");
    }
    let suppliedUsername;
    try {
      suppliedUsername = decodeURIComponent(testUrl.username);
    } catch {
      throw new Error("DAY6_TEST_MONGO_URL contains an invalid test username.");
    }
    if (
      !suppliedUsername ||
      !testUrl.password ||
      suppliedUsername !== expectedTestUsername ||
      suppliedUsername === applicationUsername
    ) {
      throw new Error("DAY6_TEST_MONGO_URL must use the configured dedicated test username.");
    }
    if (testUrl.searchParams.getAll("authSource").length !== 1 ||
        testUrl.searchParams.get("authSource") !== "admin") {
      throw new Error("DAY6_TEST_MONGO_URL must explicitly use authSource=admin.");
    }
    console.log("Day 6 test database:", testUrl.pathname);
console.log("Day 6 test username matches:", suppliedUsername === expectedTestUsername);
console.log("Day 6 authSource:", testUrl.searchParams.get("authSource"));
    process.env.MONGO_URL = testUrl.toString();
    process.env.JWT_SECRET = `day6-test-${randomUUID()}`;
    process.env.STAFF_KEY = `day6-staff-${randomUUID()}`;
    process.env.RAZORPAY_KEY_ID = "disabled-for-day6-integration";
    process.env.RAZORPAY_KEY_SECRET = "disabled-for-day6-integration";

    const { indiaDay } = require("../services/day6Service");
    const mongoose = require("mongoose");
    const app = require("../index");
    const {
      BankAccount,
      DailySpend,
      RateLimitCounter,
      Transaction,
      User,
      Wallet,
      Withdrawal,
      LedgerEntry,
      MoneyRequest,
      OutboxEvent,
      PaymentOrder,
      connectDB,
    } = require("../db");
    const { withdrawalQueue } = require("../queues/withdrawalQueue");

    const testModels = [
      User,
      Wallet,
      Transaction,
      LedgerEntry,
      PaymentOrder,
      BankAccount,
      Withdrawal,
      OutboxEvent,
      DailySpend,
      RateLimitCounter,
      MoneyRequest,
    ];
    const testCollectionNames = testModels.map((model) => model.collection.collectionName);

    async function clearTestCollections() {
      if (mongoose.connection.name !== TEST_DATABASE_NAME || !mongoose.connection.db) {
        throw new Error("Refusing to clean up an unexpected MongoDB database.");
      }
      for (const collectionName of TEST_COLLECTIONS) {
        await mongoose.connection.db.collection(collectionName).deleteMany({});
      }
    }

    const originalQueueAdd = withdrawalQueue.add;
    withdrawalQueue.add = async () => ({ id: "day6-test-job" });
    const server = app.listen(0);
    const serverListening = new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    t.after(async () => {
      if (server.listening) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
      withdrawalQueue.add = originalQueueAdd;
      try {
        if (mongoose.connection.readyState === 1) {
          await clearTestCollections();
        }
      } catch {
        throw new Error("Could not clear the allowlisted Day 6 test collections.");
      } finally {
        await mongoose.disconnect();
        await withdrawalQueue.close();
      }
    });

    if (
      testCollectionNames.length !== TEST_COLLECTIONS.length ||
      TEST_COLLECTIONS.some((name) => !testCollectionNames.includes(name))
    ) {
      throw new Error("Day 6 model collections do not match the approved cleanup allowlist.");
    }

    await connectDB().catch((error) => {
      const safeMessage = String(error.message || "Unknown MongoDB connection error")
        .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, "[REDACTED_MONGODB_URL]")
        .replace(/(password\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
      const details = [
        error.name && `name=${error.name}`,
        error.code !== undefined && `code=${error.code}`,
        error.codeName && `codeName=${error.codeName}`,
        `message=${safeMessage}`,
      ].filter(Boolean).join(", ");
      throw new Error(
        `Could not connect to the isolated Day 6 MongoDB database (${details}).`
      );
    });
    if (mongoose.connection.name !== TEST_DATABASE_NAME) {
      throw new Error("Connected MongoDB database does not match the fixed Day 6 test database.");
    }
    await clearTestCollections();
    await serverListening;
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    async function request(method, path, { token, body, headers = {} } = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      return {
        response,
        body: await response.json(),
      };
    }

    async function signup(label) {
      const user = {
        firstName: label,
        lastName: "Day6",
        username: `${label.toLowerCase()}-${randomUUID()}@example.test`,
        password: "day6-test-password",
      };
      const result = await request("POST", "/api/v1/user/signup", { body: user });
      assert.equal(result.response.status, 201);
      return { ...user, id: result.body.user.id };
    }

    async function signin(user) {
      const result = await request("POST", "/api/v1/user/signin", {
        body: { username: user.username, password: user.password },
      });
      assert.equal(result.response.status, 200);
      return result.body.token;
    }

    async function setPin(token, pin = "5829", password = "day6-test-password") {
      return request("POST", "/api/v1/user/pin", {
        token,
        body: { password, pin },
      });
    }

    async function deposit(staffToken, userId, amount) {
      const result = await request("POST", "/api/v1/wallet/deposit", {
        token: staffToken,
        headers: { "x-admin-key": process.env.STAFF_KEY },
        body: { userId, amount, description: "Isolated Day 6 test funding" },
      });
      assert.equal(result.response.status, 201);
    }

    async function transfer(token, toUserId, amount, pin, key) {
      return request("POST", "/api/v1/wallet/transfer", {
        token,
        headers: { "Idempotency-Key": key },
        body: { toUserId, amount, pin },
      });
    }

    const staffUser = await signup("Staff");
    const receiver = await signup("Receiver");
    const lockedUser = await signup("Locked");
    const resetUser = await signup("Reset");
    const limitUser = await signup("Limit");
    const rateUser = await signup("Rate");
    const logoutUser = await signup("Logout");
    const passwordUser = await signup("Password");
    const concurrentPinUser = await signup("ConcurrentPin");
    const concurrentSpendUser = await signup("ConcurrentSpend");
    await RateLimitCounter.deleteMany({});
    const requestOwner = await signup("RequestOwner");
    const requestPayer = await signup("RequestPayer");
    const requestStranger = await signup("RequestStranger");
    const requestConcurrentPayer = await signup("RequestConcurrentPayer");
    const requestSpamOwner = await signup("RequestSpamOwner");
    const requestRateOwner = await signup("RequestRateOwner");
    const staffToken = await signin(staffUser);
    const receiverToken = await signin(receiver);
    const requestOwnerToken = await signin(requestOwner);
    const requestPayerToken = await signin(requestPayer);
    const requestStrangerToken = await signin(requestStranger);
    const requestConcurrentPayerToken = await signin(requestConcurrentPayer);
    const requestSpamOwnerToken = await signin(requestSpamOwner);
    const requestRateOwnerToken = await signin(requestRateOwner);
    assert.ok(receiverToken);

    await t.test("D1 PIN setup, validation, and safe /me response", async () => {
      const token = await signin(lockedUser);
      for (const pin of ["1234", "0000"]) {
        const result = await setPin(token, pin);
        assert.equal(result.response.status, 400);
        assert.equal(result.body.message, "PIN is too easy to guess");
      }
      const malformed = await setPin(token, "12a4");
      assert.equal(malformed.response.status, 400);
      assert.equal(malformed.body.message, "PIN must be 4 or 6 digits");
      const wrongPassword = await setPin(token, "5829", "not-the-password");
      assert.equal(wrongPassword.response.status, 401);
      assert.equal(wrongPassword.body.message, "Wrong password");
      const set = await setPin(token);
      assert.equal(set.response.status, 200);
      assert.equal(set.body.message, "PIN set");

      const me = await request("GET", "/api/v1/user/me", { token });
      assert.equal(me.body.user.hasPin, true);
      assert.equal("pinHash" in me.body.user, false);
    });

    await t.test("D2 atomic lockout, staff unlock, and idempotent transfer", async () => {
      const token = await signin(lockedUser);
      await deposit(staffToken, lockedUser.id, 100000);
      const key = `d2-${randomUUID()}`;
      const first = await transfer(token, receiver.id, 1000, "0000", key);
      const second = await transfer(token, receiver.id, 1000, "0000", key);
      const third = await transfer(token, receiver.id, 1000, "0000", key);
      assert.equal(first.response.status, 403);
      assert.equal(first.body.triesLeft, 2);
      assert.equal(first.body.message.includes("0000"), false);
      assert.equal(second.body.triesLeft, 1);
      assert.equal(third.response.status, 423);
      assert.equal(third.body.retryAfterSeconds, 900);
      const lockedCorrect = await transfer(token, receiver.id, 1000, "5829", key);
      assert.equal(lockedCorrect.response.status, 423);

      const unlock = await request(
        "POST",
        `/api/v1/admin/users/${lockedUser.id}/unlock-pin`,
        {
          token: staffToken,
          headers: { "x-admin-key": process.env.STAFF_KEY },
        }
      );
      assert.equal(unlock.response.status, 200);

      const success = await transfer(token, receiver.id, 1000, "5829", key);
      assert.equal(success.response.status, 200);
      const replay = await transfer(token, receiver.id, 1000, "5829", key);
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.replayed, true);
      assert.equal(
        replay.body.transaction.id,
        success.body.transaction.id
      );
      const savedTransfer = await Transaction.findOne({
        fromUserId: lockedUser.id,
        idempotencyKey: key,
      }).lean();
      assert.ok(savedTransfer);
      assert.equal(JSON.stringify(savedTransfer).includes("5829"), false);

      const account = await request("POST", "/api/v1/wallet/bank-accounts", {
        token,
        body: {
          accountHolderName: "Day6 Test",
          accountNumber: "987654321",
          ifsc: "TEST0123456",
        },
      });
      assert.equal(account.response.status, 201);
      const insufficient = await request("POST", "/api/v1/wallet/withdrawals", {
        token,
        headers: { "Idempotency-Key": `d2-insufficient-${randomUUID()}` },
        body: {
          bankAccountId: account.body.bankAccount.id,
          amount: 200000,
          pin: "5829",
        },
      });
      assert.equal(insufficient.response.status, 409);
      const afterInsufficient = await request("GET", "/api/v1/wallet/limits", { token });
      assert.equal(afterInsufficient.body.usedToday, 1000);
    });

    await t.test("D3 successful PIN resets failed attempts", async () => {
      const token = await signin(resetUser);
      await setPin(token);
      await deposit(staffToken, resetUser.id, 10000);
      const badBefore = await transfer(
        token, receiver.id, 1000, "0000", `d3-bad-a-${randomUUID()}`
      );
      assert.equal(badBefore.response.status, 403);
      assert.equal(badBefore.body.triesLeft, 2);
      const good = await transfer(
        token, receiver.id, 1000, "5829", `d3-good-${randomUUID()}`
      );
      assert.equal(good.response.status, 200);
      const badAfter = await transfer(
        token, receiver.id, 1000, "0000", `d3-bad-b-${randomUUID()}`
      );
      assert.equal(badAfter.response.status, 403);
      assert.equal(badAfter.body.triesLeft, 2);
    });

    await t.test("concurrent wrong PIN attempts cannot exceed three reservations", async () => {
      const token = await signin(concurrentPinUser);
      await setPin(token);
      const attempts = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          transfer(
            token,
            receiver.id,
            100,
            "0000",
            `concurrent-pin-${index}-${randomUUID()}`
          )
        )
      );
      assert.equal(attempts.filter((result) => result.response.status === 429).length, 0);
      assert.equal(
        attempts.filter((result) => [403, 423].includes(result.response.status)).length,
        10
      );
      const pinState = await User.findById(concurrentPinUser.id)
        .select("pinFailedCount pinLockedUntil")
        .lean();
      assert.equal(pinState.pinFailedCount, 3);
      assert.ok(pinState.pinLockedUntil instanceof Date);
    });

    await t.test("D4 transfer and withdrawal share the India-day limit", async () => {
      const token = await signin(limitUser);
      await setPin(token);
      await deposit(staffToken, limitUser.id, 2000000);
      const accountResult = await request("POST", "/api/v1/wallet/bank-accounts", {
        token,
        body: {
          accountHolderName: "Day6 Test",
          accountNumber: "123456789",
          ifsc: "TEST0123456",
          testScenario: "SUCCESS",
        },
      });
      assert.equal(accountResult.response.status, 201);
      const bankAccountId = accountResult.body.bankAccount.id;

      const initialLimits = await request("GET", "/api/v1/wallet/limits", { token });
      assert.equal(initialLimits.body.dailyLimit, 1000000);
      assert.equal(initialLimits.body.usedToday, 0);
      assert.equal(initialLimits.body.leftToday, 1000000);

      assert.equal((await transfer(token, receiver.id, 500000, "5829", `d4-a-${randomUUID()}`)).response.status, 200);
      assert.equal((await transfer(token, receiver.id, 400000, "5829", `d4-b-${randomUUID()}`)).response.status, 200);
      const before = await request("GET", "/api/v1/wallet/balance", { token });
      const rejected = await request("POST", "/api/v1/wallet/withdrawals", {
        token,
        headers: { "Idempotency-Key": `d4-rejected-${randomUUID()}` },
        body: { bankAccountId, amount: 150000, pin: "5829" },
      });
      assert.equal(rejected.response.status, 400);
      assert.equal(rejected.body.message, "Daily limit reached");
      assert.equal(rejected.body.leftToday, 100000);
      const after = await request("GET", "/api/v1/wallet/balance", { token });
      assert.equal(after.body.balance, before.body.balance);

      const accepted = await request("POST", "/api/v1/wallet/withdrawals", {
        token,
        headers: { "Idempotency-Key": `d4-accepted-${randomUUID()}` },
        body: { bankAccountId, amount: 100000, pin: "5829" },
      });
      assert.equal(accepted.response.status, 202);
      const finalLimits = await request("GET", "/api/v1/wallet/limits", { token });
      assert.equal(finalLimits.body.usedToday, 1000000);
      assert.equal(finalLimits.body.leftToday, 0);
    });

    await t.test("D5 signin limits block incorrect and correct follow-up attempts", async () => {
      await RateLimitCounter.deleteMany({});
      const wrongRemaining = [];
      for (let index = 0; index < 5; index += 1) {
        const result = await request("POST", "/api/v1/user/signin", {
          body: { username: logoutUser.username, password: "wrong-password" },
        });
        assert.equal(result.response.status, 401);
        wrongRemaining.push(result.response.headers.get("x-ratelimit-remaining"));
      }
      assert.deepEqual(wrongRemaining, ["4", "3", "2", "1", "0"]);

      const blockedCorrect = await request("POST", "/api/v1/user/signin", {
        body: { username: logoutUser.username, password: logoutUser.password },
      });
      assert.equal(blockedCorrect.response.status, 429);
      assert.ok(blockedCorrect.response.headers.get("retry-after"));
    });

    await t.test("D6 transfer and withdrawal share one money limit", async () => {
      const token = await signin(rateUser);
      await setPin(token);
      await deposit(staffToken, rateUser.id, 10000);

      const now = Date.now();
      const currentWindowStart =
        Math.floor(now / MONEY_RATE_LIMIT_WINDOW_MS) *
        MONEY_RATE_LIMIT_WINDOW_MS;
      const elapsedInWindow = now - currentWindowStart;
      const safeWindowStart =
        elapsedInWindow <= 1000
          ? currentWindowStart
          : currentWindowStart + MONEY_RATE_LIMIT_WINDOW_MS;
      const delayUntilSafeWindow = safeWindowStart + 1000 - now;
      if (delayUntilSafeWindow > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayUntilSafeWindow));
      }

      const testedWindowStart =
        Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
        MONEY_RATE_LIMIT_WINDOW_MS;
      await RateLimitCounter.deleteMany({});
      for (let index = 0; index < 10; index += 1) {
        assert.equal(
          Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
            MONEY_RATE_LIMIT_WINDOW_MS,
          testedWindowStart,
          "transfer sequence must remain in the same fixed rate-limit window"
        );
        const result = await transfer(
          token,
          receiver.id,
          100,
          "5829",
          `d6-shared-${index}-${randomUUID()}`
        );
        assert.equal(result.response.status, 200);
        assert.equal(
          Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
            MONEY_RATE_LIMIT_WINDOW_MS,
          testedWindowStart,
          "all transfers must complete in the same fixed rate-limit window"
        );
      }
      assert.equal(
        Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
          MONEY_RATE_LIMIT_WINDOW_MS,
        testedWindowStart,
        "withdrawal must use the transfers' fixed rate-limit window"
      );
      const blockedWithdrawal = await request("POST", "/api/v1/wallet/withdrawals", {
        token,
        headers: { "Idempotency-Key": `d6-withdrawal-${randomUUID()}` },
        body: {
          bankAccountId: new mongoose.Types.ObjectId().toString(),
          amount: 100,
          pin: "5829",
        },
      });
      assert.equal(blockedWithdrawal.response.status, 429);
      assert.ok(blockedWithdrawal.response.headers.get("retry-after"));
      assert.equal(
        Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
          MONEY_RATE_LIMIT_WINDOW_MS,
        testedWindowStart,
        "the blocked withdrawal must complete in the transfers' fixed rate-limit window"
      );
    });

    await t.test("concurrent transfers cannot exceed the daily spend limit", async () => {
      const token = await signin(concurrentSpendUser);
      await setPin(token);
      await deposit(staffToken, concurrentSpendUser.id, 2000000);

      const now = Date.now();
      const currentWindowStart =
        Math.floor(now / MONEY_RATE_LIMIT_WINDOW_MS) *
        MONEY_RATE_LIMIT_WINDOW_MS;
      const elapsedInWindow = now - currentWindowStart;
      const safeWindowStart =
        elapsedInWindow <= 1000
          ? currentWindowStart
          : currentWindowStart + MONEY_RATE_LIMIT_WINDOW_MS;
      const delayUntilSafeWindow = safeWindowStart + 1000 - now;
      if (delayUntilSafeWindow > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayUntilSafeWindow));
      }

      const testedWindowStart =
        Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
        MONEY_RATE_LIMIT_WINDOW_MS;
      const assertSameRateLimitWindow = () => {
        assert.equal(
          Math.floor(Date.now() / MONEY_RATE_LIMIT_WINDOW_MS) *
            MONEY_RATE_LIMIT_WINDOW_MS,
          testedWindowStart,
          "all concurrent-spend requests must remain in the same fixed rate-limit window"
        );
      };

      await RateLimitCounter.deleteMany({});
      assertSameRateLimitWindow();

      const concurrentRequests = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          transfer(
            token,
            receiver.id,
            150000,
            "5829",
            `concurrent-spend-${index}-${randomUUID()}`
          )
        )
      );
      assertSameRateLimitWindow();
      assert.equal(
        concurrentRequests.filter((result) => result.response.status === 200).length,
        6
      );
      assert.equal(
        concurrentRequests.filter((result) => result.response.status === 400).length,
        4
      );
      assert.ok(
        concurrentRequests
          .filter((result) => result.response.status === 400)
          .every((result) => result.body.message === "Daily limit reached")
      );

      const rateLimitedRequests = [];
      for (let index = 10; index < 15; index += 1) {
        assertSameRateLimitWindow();
        const result = await transfer(
          token,
          receiver.id,
          150000,
          "5829",
          `concurrent-spend-${index}-${randomUUID()}`
        );
        assert.equal(result.response.status, 429);
        rateLimitedRequests.push(result);
        assertSameRateLimitWindow();
      }
      assert.equal(rateLimitedRequests.length, 5);

      const limits = await request("GET", "/api/v1/wallet/limits", { token });
      assert.equal(limits.body.usedToday, 900000);
      assert.equal(limits.body.leftToday, 100000);
      assertSameRateLimitWindow();
      const finalBalance = await request("GET", "/api/v1/wallet/balance", { token });
      assert.equal(finalBalance.body.balance, 1100000);
      assertSameRateLimitWindow();
    });

    await t.test("D7 logout-all invalidates every prior token", async () => {
      await RateLimitCounter.deleteMany({});
      const tokenOne = await signin(logoutUser);
      const tokenTwo = await signin(logoutUser);
      assert.equal((await request("GET", "/api/v1/user/me", { token: tokenOne })).response.status, 200);
      assert.equal((await request("GET", "/api/v1/user/me", { token: tokenTwo })).response.status, 200);
      const logout = await request("POST", "/api/v1/user/logout-all", { token: tokenOne });
      assert.equal(logout.body.message, "Signed out on all devices");
      for (const token of [tokenOne, tokenTwo]) {
        const result = await request("GET", "/api/v1/user/me", { token });
        assert.equal(result.response.status, 401);
        assert.equal(result.body.message, "Session ended. Please sign in again");
      }
      const newToken = await signin(logoutUser);
      assert.equal((await request("GET", "/api/v1/user/me", { token: newToken })).response.status, 200);
    });

    await t.test("D8 password change invalidates old token and returns a fresh one", async () => {
      await RateLimitCounter.deleteMany({});
      const oldToken = await signin(passwordUser);
      const changed = await request("PUT", "/api/v1/user", {
        token: oldToken,
        body: {
          currentPassword: passwordUser.password,
          newPassword: "day6-new-password",
        },
      });
      assert.equal(changed.response.status, 200);
      assert.ok(changed.body.token);
      assert.equal((await request("GET", "/api/v1/user/me", { token: oldToken })).response.status, 401);
      assert.equal((await request("GET", "/api/v1/user/me", { token: changed.body.token })).response.status, 200);
    });

    await t.test("D9 reconciliation remains conserved after Day 6 movements", async () => {
      const result = await request("GET", "/api/v1/admin/reconcile", {
        token: staffToken,
        headers: { "x-admin-key": process.env.STAFF_KEY },
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.consistent, true);
      assert.equal(result.body.moneyIsConserved, true);
      assert.deepEqual(result.body.discrepancies, []);
      assert.deepEqual(result.body.mismatches, []);
      assert.ok(await User.countDocuments({}) >= 8);
      assert.ok(await DailySpend.countDocuments({ spent: { $gt: 0 } }) >= 1);
      const savedUser = await User.findById(lockedUser.id).select("+pinHash");
      assert.match(savedUser.pinHash, /^\$2[aby]\$/);
      assert.equal(savedUser.pinHash.includes("5829"), false);
      assert.ok(await BankAccount.countDocuments({ userId: limitUser.id }) === 1);

      const topUpWithoutPin = await request(
        "POST",
        "/api/v1/wallet/add-money/order",
        { token: receiverToken, body: { amount: 1000 } }
      );
      assert.equal(topUpWithoutPin.response.status, 503);
      assert.match(topUpWithoutPin.body.error, /Razorpay test mode is required/);
    });

    await t.test("Day 7 request creation, lists, and participant access", async () => {
      const created = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: {
          to: requestPayer.id,
          amount: 50000,
          note: "Dinner at Murugan Idli",
        },
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body.message, "Request sent");
      assert.equal(created.body.request.status, "PENDING");
      assert.equal(created.body.request.amount, 50000);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const expiryFromCreationMs =
        new Date(created.body.request.expiresAt).getTime() -
        new Date(created.body.request.createdAt).getTime();
      assert.ok(
        expiryFromCreationMs <= sevenDaysMs &&
          expiryFromCreationMs >= sevenDaysMs - 1000,
        "request expiry should be seven days from the route timestamp, within 1 second of createdAt"
      );

      const incoming = await request("GET", "/api/v1/requests/incoming", {
        token: requestPayerToken,
      });
      assert.equal(incoming.response.status, 200);
      assert.equal(incoming.body.requests[0].otherPerson.name, "RequestOwner Day6");
      assert.equal(incoming.body.requests[0].note, "Dinner at Murugan Idli");
      assert.equal(incoming.body.requests[0].status, "PENDING");

      const outgoing = await request("GET", "/api/v1/requests/outgoing", {
        token: requestOwnerToken,
      });
      assert.equal(outgoing.response.status, 200);
      assert.equal(outgoing.body.requests[0].otherPerson.name, "RequestPayer Day6");
      assert.equal(outgoing.body.requests[0].id, created.body.request.id);

      const filtered = await request("GET", "/api/v1/requests/incoming?status=PAID", {
        token: requestPayerToken,
      });
      assert.equal(filtered.response.status, 200);
      assert.equal(filtered.body.requests.length, 0);

      const readByPayer = await request(
        "GET",
        `/api/v1/requests/${created.body.request.id}`,
        { token: requestPayerToken }
      );
      assert.equal(readByPayer.response.status, 200);
      assert.equal(readByPayer.body.request.otherPerson.name, "RequestOwner Day6");

      const stranger = await request(
        "GET",
        `/api/v1/requests/${created.body.request.id}`,
        { token: requestStrangerToken }
      );
      assert.equal(stranger.response.status, 404);
      const invalidId = await request("GET", "/api/v1/requests/not-an-id", {
        token: requestOwnerToken,
      });
      assert.equal(invalidId.response.status, 404);

      const selfRequest = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestOwner.id, amount: 100 },
      });
      assert.equal(selfRequest.response.status, 400);
      const smallAmount = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 99 },
      });
      assert.equal(smallAmount.response.status, 400);
      const largeAmount = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 1000001 },
      });
      assert.equal(largeAmount.response.status, 400);
      const missingPayer = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: "0123456789abcdef01234567", amount: 100 },
      });
      assert.equal(missingPayer.response.status, 404);
    });

    await t.test("Day 7 decline and cancel use participant-scoped state transitions", async () => {
      const declineRequest = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 500 },
      });
      const declineId = declineRequest.body.request.id;

      const requesterDecline = await request(
        "POST",
        `/api/v1/requests/${declineId}/decline`,
        { token: requestOwnerToken }
      );
      assert.equal(requesterDecline.response.status, 403);

      const declined = await request(
        "POST",
        `/api/v1/requests/${declineId}/decline`,
        { token: requestPayerToken }
      );
      assert.equal(declined.response.status, 200);
      assert.equal(declined.body.request.status, "DECLINED");

      const repeatedDecline = await request(
        "POST",
        `/api/v1/requests/${declineId}/decline`,
        { token: requestPayerToken }
      );
      assert.equal(repeatedDecline.response.status, 409);
      assert.equal(repeatedDecline.body.status, "DECLINED");

      const cancelRequest = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 500 },
      });
      const cancelId = cancelRequest.body.request.id;
      const payerCancel = await request(
        "POST",
        `/api/v1/requests/${cancelId}/cancel`,
        { token: requestPayerToken }
      );
      assert.equal(payerCancel.response.status, 403);

      const strangerCancel = await request(
        "POST",
        `/api/v1/requests/${cancelId}/cancel`,
        { token: requestStrangerToken }
      );
      assert.equal(strangerCancel.response.status, 404);

      const cancelled = await request(
        "POST",
        `/api/v1/requests/${cancelId}/cancel`,
        { token: requestOwnerToken }
      );
      assert.equal(cancelled.response.status, 200);
      assert.equal(cancelled.body.request.status, "CANCELLED");
    });

    await t.test("Day 7 payment is PIN checked, idempotent, and recorded as a transfer", async () => {
      await setPin(requestPayerToken);
      await deposit(staffToken, requestPayer.id, 100000);
      const payerBalanceBefore = (await Wallet.findOne({ userId: requestPayer.id })).balance;
      const requesterBalanceBefore = (await Wallet.findOne({ userId: requestOwner.id })).balance;
      const created = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: {
          to: requestPayer.id,
          amount: 50000,
          note: "Dinner share",
        },
      });
      assert.equal(created.response.status, 201);

      const idempotencyKey = `day7-pay-${randomUUID()}`;
      const wrongPin = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "0000" },
        }
      );
      assert.equal(wrongPin.response.status, 403);
      assert.equal(
        await Transaction.countDocuments({ moneyRequestId: created.body.request.id }),
        0
      );

      const missingKey = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          body: { pin: "5829" },
        }
      );
      assert.equal(missingKey.response.status, 400);

      const paid = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "5829" },
        }
      );
      assert.equal(paid.response.status, 200);
      assert.equal(paid.body.message, "Request paid");
      assert.equal(paid.body.balance, 50000);
      assert.equal(paid.body.replayed, false);

      const replay = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "5829" },
        }
      );
      assert.equal(replay.response.status, 200);
      assert.equal(replay.body.transactionId, paid.body.transactionId);
      assert.equal(replay.body.balance, paid.body.balance);
      assert.equal(replay.body.replayed, true);

      const differentKey = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": `${idempotencyKey}-different` },
          body: { pin: "5829" },
        }
      );
      assert.equal(differentKey.response.status, 409);

      const paidRequest = await MoneyRequest.findById(created.body.request.id);
      assert.equal(paidRequest.status, "PAID");
      assert.equal(paidRequest.transactionId.toString(), paid.body.transactionId);
      const transaction = await Transaction.findById(paid.body.transactionId);
      assert.equal(transaction.type, "TRANSFER");
      assert.equal(transaction.description, "Request: Dinner share");
      assert.equal(transaction.moneyRequestId.toString(), paidRequest._id.toString());
      assert.equal(
        (await Wallet.findOne({ userId: requestPayer.id })).balance,
        payerBalanceBefore - 50000
      );
      assert.equal(
        (await Wallet.findOne({ userId: requestOwner.id })).balance,
        requesterBalanceBefore + 50000
      );
      const paymentLedgerEntries = await LedgerEntry.find({
        transactionId: transaction._id,
      }).lean();
      assert.deepEqual(
        paymentLedgerEntries.map((entry) => entry.direction).sort(),
        ["CREDIT", "DEBIT"]
      );
      assert.equal(
        await Transaction.countDocuments({ moneyRequestId: paidRequest._id }),
        1
      );

      const payerHistory = await request("GET", "/api/v1/wallet/transactions", {
        token: requestPayerToken,
      });
      const requesterHistory = await request("GET", "/api/v1/wallet/transactions", {
        token: requestOwnerToken,
      });
      assert.ok(payerHistory.body.transactions.some((entry) =>
        entry.id === paid.body.transactionId &&
        entry.direction === "OUT" &&
        entry.description === "Request: Dinner share"
      ));
      assert.ok(requesterHistory.body.transactions.some((entry) =>
        entry.id === paid.body.transactionId &&
        entry.direction === "IN" &&
        entry.description === "Request: Dinner share"
      ));
    });

    await t.test("Day 7 failed payment rolls back request and daily spend", async () => {
      await setPin(requestStrangerToken);
      const created = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestStranger.id, amount: 500 },
      });
      assert.equal(created.response.status, 201);
      const idempotencyKey = `day7-insufficient-${randomUUID()}`;

      const insufficient = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestStrangerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "5829" },
        }
      );
      assert.equal(insufficient.response.status, 409);
      assert.equal(insufficient.body.code, "INSUFFICIENT_FUNDS");
      assert.equal(
        (await MoneyRequest.findById(created.body.request.id)).status,
        "PENDING"
      );
      assert.equal(
        await DailySpend.findOne({ userId: requestStranger.id, day: require("../services/day6Service").indiaDay() })
          .then((counter) => counter?.spent || 0),
        0
      );

      await deposit(staffToken, requestStranger.id, 1000);
      const retried = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestStrangerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "5829" },
        }
      );
      assert.equal(retried.response.status, 200);
    });

    await t.test("Day 7 daily-limit failure leaves payment pending and retryable", async () => {
      const day = indiaDay();
      await DailySpend.updateOne(
        { userId: requestPayer.id, day },
        { $set: { spent: 999600 } },
        { upsert: true }
      );
      const created = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 500 },
      });
      assert.equal(created.response.status, 201);
      const idempotencyKey = `day7-daily-limit-${randomUUID()}`;

      const limited = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "5829" },
        }
      );
      assert.equal(limited.response.status, 400);
      assert.equal(limited.body.code, "DAILY_LIMIT_REACHED");
      assert.equal(
        (await MoneyRequest.findById(created.body.request.id)).status,
        "PENDING"
      );
      assert.equal((await DailySpend.findOne({ userId: requestPayer.id, day })).spent, 999600);

      await DailySpend.updateOne(
        { userId: requestPayer.id, day },
        { $set: { spent: 0 } }
      );
      const retry = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": idempotencyKey },
          body: { pin: "5829" },
        }
      );
      assert.equal(retry.response.status, 200);
      assert.equal((await DailySpend.findOne({ userId: requestPayer.id, day })).spent, 500);
    });

    await t.test("Day 7 concurrent payments and cancellation allow only one outcome", async () => {
      await setPin(requestConcurrentPayerToken);
      await deposit(staffToken, requestConcurrentPayer.id, 100000);
      const sameKeyRequest = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestConcurrentPayer.id, amount: 1000 },
      });
      const sameKey = `day7-concurrent-same-${randomUUID()}`;
      const sameKeyResults = await Promise.all([
        request("POST", `/api/v1/requests/${sameKeyRequest.body.request.id}/pay`, {
          token: requestConcurrentPayerToken,
          headers: { "Idempotency-Key": sameKey },
          body: { pin: "5829" },
        }),
        request("POST", `/api/v1/requests/${sameKeyRequest.body.request.id}/pay`, {
          token: requestConcurrentPayerToken,
          headers: { "Idempotency-Key": sameKey },
          body: { pin: "5829" },
        }),
      ]);
      assert.deepEqual(sameKeyResults.map((result) => result.response.status), [200, 200]);
      assert.equal(sameKeyResults[0].body.transactionId, sameKeyResults[1].body.transactionId);
      assert.equal(
        await Transaction.countDocuments({ moneyRequestId: sameKeyRequest.body.request.id }),
        1
      );

      const competingRequest = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestConcurrentPayer.id, amount: 1000 },
      });
      const competingResults = await Promise.all([
        request("POST", `/api/v1/requests/${competingRequest.body.request.id}/pay`, {
          token: requestConcurrentPayerToken,
          headers: { "Idempotency-Key": `day7-concurrent-a-${randomUUID()}` },
          body: { pin: "5829" },
        }),
        request("POST", `/api/v1/requests/${competingRequest.body.request.id}/pay`, {
          token: requestConcurrentPayerToken,
          headers: { "Idempotency-Key": `day7-concurrent-b-${randomUUID()}` },
          body: { pin: "5829" },
        }),
      ]);
      assert.deepEqual(
        competingResults.map((result) => result.response.status).sort(),
        [200, 409]
      );
      assert.equal(
        await Transaction.countDocuments({ moneyRequestId: competingRequest.body.request.id }),
        1
      );

      const cancelRace = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestConcurrentPayer.id, amount: 1000 },
      });
      const cancelRaceResults = await Promise.all([
        request("POST", `/api/v1/requests/${cancelRace.body.request.id}/pay`, {
          token: requestConcurrentPayerToken,
          headers: { "Idempotency-Key": `day7-cancel-race-${randomUUID()}` },
          body: { pin: "5829" },
        }),
        request("POST", `/api/v1/requests/${cancelRace.body.request.id}/cancel`, {
          token: requestOwnerToken,
        }),
      ]);
      assert.deepEqual(
        cancelRaceResults.map((result) => result.response.status).sort(),
        [200, 409]
      );
      const finalRequest = await MoneyRequest.findById(cancelRace.body.request.id);
      const movedTransactions = await Transaction.countDocuments({
        moneyRequestId: finalRequest._id,
      });
      assert.equal(movedTransactions, finalRequest.status === "PAID" ? 1 : 0);
    });

    await t.test("Day 7 expired requests are rejected and lazily expired in both lists", async () => {
      const expiredForPay = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      await MoneyRequest.findByIdAndUpdate(expiredForPay.body.request.id, {
        $set: { expiresAt: new Date(Date.now() - 1000) },
      });

      const payExpired = await request(
        "POST",
        `/api/v1/requests/${expiredForPay.body.request.id}/pay`,
        {
          token: requestPayerToken,
          headers: { "Idempotency-Key": `day7-expired-pay-${randomUUID()}` },
          body: { pin: "5829" },
        }
      );
      assert.equal(payExpired.response.status, 410);
      assert.equal(payExpired.body.message, "This request has expired");

      const expiredForDecline = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      await MoneyRequest.findByIdAndUpdate(expiredForDecline.body.request.id, {
        $set: { expiresAt: new Date(Date.now() - 1000) },
      });
      const declineExpired = await request(
        "POST",
        `/api/v1/requests/${expiredForDecline.body.request.id}/decline`,
        { token: requestPayerToken }
      );
      assert.equal(declineExpired.response.status, 410);

      const incoming = await request(
        "GET",
        "/api/v1/requests/incoming?status=EXPIRED",
        { token: requestPayerToken }
      );
      assert.equal(incoming.response.status, 200);
      assert.equal(
        (await MoneyRequest.findById(expiredForDecline.body.request.id)).status,
        "EXPIRED"
      );

      const expiredForOutgoing = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      await MoneyRequest.findByIdAndUpdate(expiredForOutgoing.body.request.id, {
        $set: { expiresAt: new Date(Date.now() - 1000) },
      });
      const outgoing = await request("GET", "/api/v1/requests/outgoing?status=EXPIRED", {
        token: requestOwnerToken,
      });
      assert.equal(outgoing.response.status, 200);
      assert.equal(
        (await MoneyRequest.findById(expiredForOutgoing.body.request.id)).status,
        "EXPIRED"
      );

      const expiredForCancel = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      await MoneyRequest.findByIdAndUpdate(expiredForCancel.body.request.id, {
        $set: { expiresAt: new Date(Date.now() - 1000) },
      });
      const cancelExpired = await request(
        "POST",
        `/api/v1/requests/${expiredForCancel.body.request.id}/cancel`,
        { token: requestOwnerToken }
      );
      assert.equal(cancelExpired.response.status, 410);
    });

    await t.test("Day 7 pending-request and hourly creation limits are enforced", async () => {
      const samePersonRequests = [];
      for (let index = 0; index < 5; index += 1) {
        const created = await request("POST", "/api/v1/requests", {
          token: requestSpamOwnerToken,
          body: { to: requestPayer.id, amount: 100 },
        });
        assert.equal(created.response.status, 201);
        samePersonRequests.push(created.body.request.id);
      }

      const sixth = await request("POST", "/api/v1/requests", {
        token: requestSpamOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      assert.equal(sixth.response.status, 409);
      assert.equal(
        sixth.body.message,
        "You already have 5 pending requests to this person"
      );

      const declined = await request(
        "POST",
        `/api/v1/requests/${samePersonRequests[0]}/decline`,
        { token: requestPayerToken }
      );
      assert.equal(declined.response.status, 200);
      const replacement = await request("POST", "/api/v1/requests", {
        token: requestSpamOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      assert.equal(replacement.response.status, 201);

      await RateLimitCounter.deleteMany({});
      const rateRecipients = [
        requestPayer,
        requestStranger,
        requestConcurrentPayer,
        requestOwner,
      ];
      for (let index = 0; index < 20; index += 1) {
        const created = await request("POST", "/api/v1/requests", {
          token: requestRateOwnerToken,
          body: {
            to: rateRecipients[Math.floor(index / 5)].id,
            amount: 100,
          },
        });
        assert.equal(created.response.status, 201, `request ${index + 1} should be allowed`);
      }

      const outgoing = await request("GET", "/api/v1/requests/outgoing", {
        token: requestRateOwnerToken,
      });
      assert.equal(outgoing.response.status, 200);
      assert.equal(outgoing.body.requests.length, 20);
      const requestTimes = outgoing.body.requests.map((item) =>
        new Date(item.createdAt).getTime()
      );
      assert.ok(requestTimes.every((time, index) =>
        index === 0 || requestTimes[index - 1] >= time
      ));

      const rateLimited = await request("POST", "/api/v1/requests", {
        token: requestRateOwnerToken,
        body: { to: requestPayer.id, amount: 100 },
      });
      assert.equal(rateLimited.response.status, 429);
      assert.equal(rateLimited.response.headers.get("X-RateLimit-Limit"), "20");
      assert.equal(rateLimited.response.headers.get("X-RateLimit-Remaining"), "0");
      assert.ok(Number(rateLimited.response.headers.get("Retry-After")) >= 1);

    });

    await t.test("Day 7 payment shares the existing transfer money rate limit", async () => {
      await RateLimitCounter.deleteMany({});
      for (let index = 0; index < 10; index += 1) {
        const transferred = await transfer(
          requestConcurrentPayerToken,
          receiver.id,
          100,
          "5829",
          `day7-shared-rate-${index}-${randomUUID()}`
        );
        assert.equal(transferred.response.status, 200);
      }

      const created = await request("POST", "/api/v1/requests", {
        token: requestOwnerToken,
        body: { to: requestConcurrentPayer.id, amount: 100 },
      });
      assert.equal(created.response.status, 201);
      const blocked = await request(
        "POST",
        `/api/v1/requests/${created.body.request.id}/pay`,
        {
          token: requestConcurrentPayerToken,
          headers: { "Idempotency-Key": `day7-shared-rate-pay-${randomUUID()}` },
          body: { pin: "5829" },
        }
      );
      assert.equal(blocked.response.status, 429);
      assert.equal(blocked.response.headers.get("X-RateLimit-Limit"), "10");
      assert.equal(
        (await MoneyRequest.findById(created.body.request.id)).status,
        "PENDING"
      );
      assert.equal(
        await Transaction.countDocuments({ moneyRequestId: created.body.request.id }),
        0
      );

      const reconciliation = await request("GET", "/api/v1/admin/reconcile", {
        token: staffToken,
        headers: { "x-admin-key": process.env.STAFF_KEY },
      });
      assert.equal(reconciliation.response.status, 200);
      assert.equal(reconciliation.body.moneyIsConserved, true);
      assert.deepEqual(reconciliation.body.mismatches, []);
    });
  }
);
