# Day 5: Withdrawals

## Withdrawal flow

`POST /api/v1/wallet/withdrawals` reserves the requested paise from the user's wallet and writes the withdrawal, debit transaction, debit ledger entry, and payout outbox event in one MongoDB transaction. It returns `202 Accepted`; the request handler never contacts the bank.

The outbox is the durable source of payout work. BullMQ dispatches events to the existing worker, and the worker also scans MongoDB for due events so a committed request can be redispatched if Redis was unavailable. Workers atomically claim outbox events and reuse the same payout reference on every attempt.

## Statuses and failure policy

- `PENDING`: funds are reserved and the payout is waiting to run or retry.
- `PROCESSING`: a worker has claimed the payout.
- `SUCCEEDED`: the local fake bank confirmed the payout.
- `REVERSED`: the fake bank permanently rejected the payout and a credit `REVERSAL` transaction and ledger entry refunded the reserved funds exactly once.
- `NEEDS_REVIEW`: five attempts did not produce a confirmed result. Funds remain reserved; an unknown timeout is not treated as proof of failure.

The outbox uses `PENDING`, `PROCESSING`, `DONE`, and `STUCK`. Retry delays use exponential backoff with jitter and cap at five attempts. Stale worker locks are recovered by the worker's outbox scan.

## Local test bank

The worker only accepts an HTTP `BANK_URL` on localhost and defaults to `http://localhost:4000`. The included fake bank never contacts a real bank. Add a bank account with a test scenario to exercise it:

- `SUCCESS` (default): succeed immediately.
- `TEMPORARY_FAILURE`: return two retryable errors, then succeed.
- `TIMEOUT`: delay confirmation beyond the worker's three-second timeout, then return the same payout result on retry.
- `CLOSED_ACCOUNT`: permanently reject; the wallet reservation is refunded as a reversal.

Run the API, worker, and fake bank in separate terminals:

```powershell
npm start
npm run worker
npm run fake-bank
```

The legacy `POST /api/v1/wallet/withdraw` endpoint is retired and returns `410 Gone` without queuing work. The persisted, authenticated withdrawal API is `POST /api/v1/wallet/withdrawals`; it requires a payment PIN and uses the shared transfer/withdrawal rate limit and daily spending limit.

Staff can inspect unresolved requests at `GET /api/v1/admin/withdrawals?status=NEEDS_REVIEW` using a signed-in account and the configured `x-staff-key`. The response contains masked account details only.

## Interview notes

- **Why use an outbox?** It commits the payout work record together with the wallet reservation, so a temporary Redis outage cannot lose a withdrawal.
- **Why reserve funds at request time?** The same MongoDB transaction records a debit and prevents the user from spending the requested amount while payout is pending.
- **Why use a stable payout reference?** If the worker times out after the bank processed the request, retrying with the same reference lets the fake bank return the existing result rather than creating another payout.
- **Why not refund a timeout?** A timeout leaves the bank result unknown. Funds are refunded only after a confirmed permanent rejection; unresolved requests are marked `NEEDS_REVIEW`.
- **How are private bank details protected?** The complete account number is excluded from normal model queries and API responses; APIs return only the last four digits.
