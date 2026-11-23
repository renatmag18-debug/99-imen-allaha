# Draft: personal progress backup — not ready for deployment

This branch contains an experimental authenticated endpoint for encrypted ayah and qada snapshots. It is not connected to the Android UI and must not be deployed or presented as a complete backup solution.

## Verified locally

Run: node --test tests/personal-progress.test.mjs

The isolated fake-database tests cover authentication failure, malformed records, ciphertext storage, optimistic write conflicts, a wrong encryption key and decryption after a simple username move. They do not establish correct behaviour against production RTDB or Android.

## Release blockers

- Existing username-change code copies and deletes whole user records without a conditional transaction. A backup write racing with a rename can be lost; a plain sequential rename test is not sufficient. Fix and test rename/delete races against an isolated database before release.
- The existing server password scheme uses reversible Base64. Encrypting the backup blob does not fix account authentication, brute-force protection or credential handling. Migrate authentication without locking out existing clients before release.
- Android has no wired account-scoped store, durable offline queue, migration of existing on-device data, conflict-resolution UI, or recovery flow yet. The endpoint alone does not implement sync.
- No isolated deployed test Worker / RTDB environment has been verified. Test with two real devices and no production user records.
- Provision a random 32-byte Base64 PERSONAL_PROGRESS_KEY as an encrypted Worker secret in the isolated environment. The key must not be committed, logged, or automatically replaced. Define secure backup, rotation and disaster recovery before handling user data: losing it makes backups unreadable.
- Verify RTDB rules and access controls; configure monitoring and rollback. Review account deletion and username changes, including concurrent operations.

The encryption module fails closed when the key is missing or decryption fails. Production deployment has not been requested or performed.
