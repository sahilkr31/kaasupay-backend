# Day 6 — Lock the Wallet: Interview Answers

1. **Why require a PIN when the user already has a JWT?** The JWT proves which account is making the request. A separate payment PIN is an additional check for sensitive outgoing money actions, so a stolen logged-in session alone is not enough to transfer or withdraw funds.

2. **Why is bcrypt alone not enough for a short PIN?** A four- or six-digit PIN has a small search space. Bcrypt slows guesses but cannot make that space large. The implementation therefore also limits guesses, locks after three consecutive failures, and supports a staff-authorized unlock.

3. **Why must the PIN stay out of logs, errors, and idempotency hashes?** Logs and stored request records can be retained or viewed by systems and people that do not need a payment credential. The PIN is compared to its bcrypt hash and is not passed into the wallet service or transaction/idempotency data.

4. **What is the concurrent check-then-act problem?** Separate reads and writes can let several simultaneous wrong guesses all observe the same attempt count and exceed the limit. The failed-attempt update is a conditional atomic database update; only attempts that match the still-unlocked, below-limit document can reserve a count.

5. **What is the difference between 401, 403, and 423? Why `Retry-After`?** `401` means the session is missing or invalid, `403` means a supplied PIN is wrong, and `423` means PIN verification is temporarily locked. `Retry-After` tells the client when it may safely retry.

6. **Why use a daily counter instead of summing every transaction?** A counter makes the limit check efficient and has a single document that MongoDB can update atomically. It avoids scanning transaction history and serializes concurrent spending checks for the same user and India calendar day.

7. **Why use India time instead of UTC for the daily boundary?** The assignment defines a calendar day for users in India. A UTC date changes at 05:30 in India, so using UTC would reset the allowance at the wrong local time. The helper uses the `Asia/Kolkata` timezone.

8. **Why is the daily limit update inside the wallet transaction?** The allowance and the wallet movement must succeed or fail together. If the wallet debit, recipient credit, ledger write, or withdrawal record fails, MongoDB rolls back the spend counter update as well.

9. **How can a fixed-window limit allow double the intended rate?** A client can use the full allowance just before a window ends and another full allowance just after it starts. Sliding windows or token buckets smooth that boundary; this implementation follows the assignment's fixed-window requirement.

10. **Why do in-memory rate counters fail on multiple instances?** Each process would have a different counter, so requests distributed across instances could exceed the limit. MongoDB counters provide shared atomic state; TTL cleanup removes old records, while the window key itself determines correctness.

11. **How does `tokenVersion` invalidate sessions, and what does it cost?** JWTs carry the user's version. Authentication compares it with the current database value; logout-all or password change increments the stored value, making old JWTs fail. This adds a user lookup per authenticated request. A scalable alternative is a carefully invalidated distributed cache, while retaining a safe source of truth.

12. **What is the transfer check order, and why verify PIN before idempotency?** Authenticate and check token version; apply the shared money limiter; validate the key and request; validate the recipient and reject self-transfer; verify the PIN; then look up or create the idempotent transfer. Inside one MongoDB transaction, enforce and increment the daily counter, debit the sender, credit the recipient, and write transaction and ledger records. PIN verification comes before idempotency processing so a failed PIN cannot create or consume an idempotency record, and the PIN never becomes part of the stored request.

## Test setup and limits

Run `node --test tests/day6.test.js` for local unit checks that do not connect to MongoDB. The API integration suite requires `DAY6_TEST_MONGO_URL` and the accompanying `DAY6_TEST_MONGO_HOST`, `DAY6_APP_MONGO_HOST`, `DAY6_APP_MONGO_DATABASE`, `DAY6_TEST_MONGO_USERNAME`, and `DAY6_APP_MONGO_USERNAME` settings. It uses the fixed `kaasupay_day6_integration_test` database, verifies the configured hostname, database name, and dedicated test username, and requires `authSource=admin`. Before and after the suite, it deletes documents only from its allowlisted Day 6 collections; it does not drop the database or collections. Use a test-only MongoDB user with permissions restricted to this database and a MongoDB deployment that supports transactions. The integration suite uses test-only auth values, disables Razorpay order creation, and stubs queue dispatch. It does not test a real Razorpay payment or the Day 5 worker/Redis payout flow.
