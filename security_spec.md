# Security Specification: Lumina Arcadia Pre-registration

## 1. Data Invariants
1. `Reservation`: Must contain `name` (2-50 chars), `phone` (9-15 digits), `email` (valid email format), `platform` (one of 'ios', 'android', 'pc', 'console'), and `createdAt` (string).
2. PII Protection: Non-admins cannot read or list reservations (which contain name, phone, and email). Only admin (`gladay014@gmail.com`) can read, update, or delete reservations.
3. Public Create: Any visitor can create a reservation if it strictly matches the schema and constraints.
4. Public Stats: Any visitor can read the public counter (`/stats/public`), but only admin or atomic increments can modify it.
5. Feedback: Any visitor can create feedback with `text` (1-500 chars) and `createdAt`. Only admin can list, read, or delete feedback entries.

## 2. The Dirty Dozen Payloads
1. **Ghost Field Injection**: Adding `isAdmin: true` into a reservation document.
2. **Short Name Attack**: Submitting a name with length < 2 characters (`{"name": "A"}`).
3. **Huge String DOS**: Submitting a 50KB name string to cause resource exhaustion.
4. **Invalid Platform Injection**: Submitting `platform: "hacked_console"`.
5. **Invalid Phone Attack**: Submitting non-numeric or malformed phone strings.
6. **Malicious Document ID**: Attempting to write to an ID containing directory traversal characters.
7. **Unauthorized PII Read**: Unauthenticated user trying to read `/reservations/{id}`.
8. **Unauthorized List**: Unauthenticated user trying to list the entire `/reservations` collection.
9. **Unauthorized Delete**: Non-admin user sending a `deleteDoc` request on a reservation.
10. **Unauthorized Update**: Non-admin attempting to modify another user's reservation details.
11. **Negative Counter Attack**: Setting `/stats/public` count to negative values or arbitrary objects.
12. **Feedback Buffer Overflow**: Submitting feedback text exceeding 500 characters.
