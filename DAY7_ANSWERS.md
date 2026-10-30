# Day 7: Request Money — Interview Answers

## 1. Draw and explain the request state machine and final states

```text
                 ┌──> PAID
                 ├──> DECLINED
PENDING ─────────┼──> CANCELLED
                 └──> EXPIRED
```

Only a `PENDING` request can change state. `PAID`, `DECLINED`, `CANCELLED`, and `EXPIRED` are final states. Payment, decline, and cancellation use conditional database updates so a terminal request cannot be changed again.

## 2. Explain concurrent cancel versus pay and why only one wins

Both operations try to update the same request only while its status is `PENDING`. MongoDB serializes the competing writes: one update changes the status first, and the other no longer matches the `PENDING` condition. Payment also performs its state update and money movement in one transaction, so a failed payment rolls back its claim.

## 3. Explain why reading status before updating it is unsafe

Two requests can both read `PENDING` before either writes. If each then updates based only on that earlier read, both may appear successful. Putting `status: "PENDING"` in the atomic update makes the database check and state change one operation.

## 4. Explain why changing request status and transferring money must be in one transaction

Otherwise the request could become `PAID` while the transfer fails, or the transfer could happen while the request stays `PENDING`. The payment operation uses one MongoDB session for the request update, daily-spend increment, wallet debit and credit, transaction and ledger entries, and saved transaction ID. An error aborts all of those changes together.

## 5. Explain why both idempotency and the PENDING-to-PAID check are needed

Idempotency lets a retry with the same key return the original transaction instead of moving money again. The conditional `PENDING` transition prevents a different key or concurrent request from paying the same request a second time. They protect against different kinds of duplicate requests.

## 6. Explain lazy expiry and why it suits Vercel

There is no timer, worker, or scheduled job. When a user reads their incoming or outgoing requests, one `updateMany` marks that user's overdue pending requests `EXPIRED`. This fits serverless hosting because it does not depend on a process remaining alive between requests.

## 7. Explain why an expired request cannot be paid even if its database status still says PENDING

Payment's atomic update requires both `status: "PENDING"` and `expiresAt` later than the current time. Thus a stale `PENDING` value cannot make an overdue request payable. The API returns `410` for an expired request.

## 8. Explain 404 versus 403 for request access

An unrelated user receives `404` so the API does not reveal whether someone else's request exists. A participant who is known to be involved but attempts the other participant's action receives `403`, such as a requester trying to decline.

## 9. Explain why PIN validation happens before idempotency and why the PIN is excluded from the request hash

The payment PIN is checked before looking up or recording an idempotent payment, so a wrong PIN cannot reserve an idempotency key. The stored key is a hash scoped to the payment route, request ID, and client key; it does not include the PIN, which must not be stored as transaction identity data.

## 10. Explain the incoming-list compound index and field ordering

Incoming requests filter on `payerId`, optionally filter on `status`, and sort newest first by `createdAt`. The model has `{ payerId: 1, status: 1, createdAt: -1 }` for a status-filtered list and `{ payerId: 1, createdAt: -1 }` for an unfiltered list. The corresponding outgoing indexes begin with `requesterId`.

## 11. Explain the five-pending-request limit's check-then-act trade-off versus money safety

The API counts pending requests from the requester to that payer before inserting. Two simultaneous create requests could both observe four pending requests and both insert, briefly exceeding five. This limited race is accepted because creating a request moves no money. Payment safety is stronger: payment and state transition are atomic and transactional, so the count race cannot cause duplicate money movement.

## 12. Split ₹1,000 equally among three people in paise

₹1,000 is 100,000 paise. Dividing by three gives 33,333 paise each with one paise left over. Give one person 33,334 paise and the other two 33,333 paise each: the total is exactly 100,000 paise (₹1,000).
