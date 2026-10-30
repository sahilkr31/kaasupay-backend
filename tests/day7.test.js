const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const {
  MONEY_REQUEST_EXPIRY_DAYS,
  MONEY_REQUEST_RATE_LIMIT,
} = require("../config");
const { MoneyRequest } = require("../db");
const requestRoutes = require("../routes/requests");
const { createPaymentIdempotencyKey } = require("../services/moneyRequestService");

test("money request schema enforces required fields and amount bounds", () => {
  const schema = MoneyRequest.schema;

  for (const field of ["requesterId", "payerId", "amount", "status", "expiresAt"]) {
    assert.equal(schema.path(field).isRequired, true, `${field} should be required`);
  }
  assert.equal(schema.path("amount").options.min, 100);
  assert.equal(schema.path("amount").options.max, 1000000);
  assert.equal(schema.path("note").options.maxlength, 100);
  assert.equal(schema.path("status").options.default, "PENDING");
  assert.deepEqual(schema.path("status").enumValues, [
    "PENDING",
    "PAID",
    "DECLINED",
    "CANCELLED",
    "EXPIRED",
  ]);
  assert.equal(schema.options.timestamps, true);
});

test("money request indexes support participant lists with and without status filters", () => {
  const indexes = MoneyRequest.schema.indexes().map(([keys]) => keys);
  assert.ok(indexes.some((keys) =>
    keys.payerId === 1 && keys.createdAt === -1
  ));
  assert.ok(indexes.some((keys) =>
    keys.payerId === 1 && keys.status === 1 && keys.createdAt === -1
  ));
  assert.ok(indexes.some((keys) =>
    keys.requesterId === 1 && keys.createdAt === -1
  ));
  assert.ok(indexes.some((keys) =>
    keys.requesterId === 1 && keys.status === 1 && keys.createdAt === -1
  ));
});

test("money request expiry is configured as seven days", () => {
  assert.equal(MONEY_REQUEST_EXPIRY_DAYS, 7);
  assert.deepEqual(MONEY_REQUEST_RATE_LIMIT, {
    name: "money-request-create",
    max: 20,
    windowSeconds: 3600,
  });
});

test("payment idempotency key is scoped to route, request, and client key", () => {
  const key = createPaymentIdempotencyKey({
    route: "POST:/api/v1/requests/:id/pay",
    requestId: "0123456789abcdef01234567",
    key: "attempt-1",
  });
  assert.match(key, /^[a-f\d]{64}$/);
  assert.equal(key, createPaymentIdempotencyKey({
    route: "POST:/api/v1/requests/:id/pay",
    requestId: "0123456789abcdef01234567",
    key: "attempt-1",
  }));
  assert.notEqual(key, createPaymentIdempotencyKey({
    route: "POST:/api/v1/requests/:id/pay",
    requestId: "0123456789abcdef01234568",
    key: "attempt-1",
  }));
});

test("money request create, list, and read routes require authentication", async (t) => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/requests", requestRoutes);

  const server = app.listen(0);
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/requests`;
  const cases = [
    ["POST", "", { to: "0123456789abcdef01234567", amount: 100 }],
    ["GET", "/incoming"],
    ["GET", "/outgoing"],
    ["GET", "/0123456789abcdef01234567"],
    ["POST", "/0123456789abcdef01234567/decline", {}],
    ["POST", "/0123456789abcdef01234567/cancel", {}],
    ["POST", "/0123456789abcdef01234567/pay", { pin: "5829" }],
  ];

  for (const [method, path, body] of cases) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, 401, `${method} ${path || "/"} should require authentication`);
  }
});
