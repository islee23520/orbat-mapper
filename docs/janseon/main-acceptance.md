# Trusted local main acceptance

This mechanism binds an independently trusted recorder's post-integration
attestation to Git main and the verified command-ledger tuple. It does not create
source rights, public admission, real-data producer eligibility or merge authority.
The shipped `scripts/janseon/trusted-main-recorders.json` is empty: production
recording fails closed until an owner-reviewed recorder identity and Ed25519
public key are enrolled. No CLI request, environment variable or receipt can
override that registry. Private keys are never stored in the repository.

## Trust boundary

The owner must designate the recorder operator and canonical acceptance checkout,
enroll its public key by reviewed source change, and restrict that checkout's
acceptance ref and signing key to the recorder. Release callers may read that
checkout but must not replace its registry, refs or code. The recorder must select
the actual authoritative database/binding and verify that the merged change was
reviewed for that tuple. Git ancestry alone cannot prove a database's real-world
authority, source rights or correspondence to a reviewed merge. Signing is the
recorder's attestation of those integration facts, not an inference from SQL.

The threat model rejects untrusted release callers presenting arbitrary unsigned,
unknown-key or tampered receipts. It does not defend against a compromised recorder,
private key, operator-selected authority, or caller who can modify the trusted
executable/checkout itself. This local unit is not cross-clone global admission:
deployment must nominate one canonical recorder/ref owner. No network transport,
remote ref protection, CI required-check or key provisioning is installed here.

## Ordering and serialization

`record-main-acceptance.mjs` holds `withCommandReleaseCheckpoint`'s existing
`BEGIN IMMEDIATE` writer reservation, replays/verifies the ledger, and compares
the exact expected datasetId, sequence, generationId, editionId,
mapSemanticSha256, contextSha256 and commandLogSha256. It makes no SQL changes.

The receipt denotes **post-integration main**, not a proposed/pre-merge base.
Local `refs/heads/main` must equal the expected mainCommit; its first parent must
equal baseMain. Initial enrollment requires previousReceipt=null and a missing
acceptance ref; the trusted recorder thereby explicitly enrolls the baseline
tuple. Subsequent enrollment requires the exact previous receipt object, a valid
trusted signature, previous mainCommit=baseMain, same dataset and strictly newer
sequence. Two candidates from one base cannot both enroll. Skipped/intervening
main commits or main-only maintenance cannot silently carry admission forward:
they require a separately reviewed policy/enrollment transition, not fabricated
ledger increments or resetting the ref.

An Ed25519 signature covers canonical payload bytes including repository URL,
main ref, recorder, base/main commits, previous receipt and the complete tuple.
The envelope is an immutable Git blob; `refs/janseon/main-acceptance` selects its
current object. `git update-ref --stdin` atomically verifies main and CAS-updates
that ref. A changed main/ref fails without replacing the winner. SQLite holds
the tuple fixed while this completes; a crash can leave an unreachable Git blob,
not a half-updated ref or invented SQLite lineage. No Git commit or merge is made.

## Entry points

Recorder request keys are exactly schema (`janseon-main-acceptance-request.v1`),
recorder, baseMain, mainCommit, previousReceipt (null only for enrollment), ledger.
Paths are separately explicit absolute CLI arguments:

```sh
node scripts/janseon/record-main-acceptance.mjs \
  --request /absolute/acceptance-request.json --binding /absolute/binding.json \
  --repository /absolute/canonical-acceptance-checkout \
  --authoritative-store /absolute/authoritative.sqlite \
  --signing-key /absolute/operator-owned-key.pem

node scripts/janseon/build-checkpoint-release.mjs \
  --request /absolute/release-request.json \
  --authoritative-store /absolute/authoritative.sqlite \
  --output-dir /absolute/new-output \
  --require-main /absolute/canonical-acceptance-checkout
```

The release checkpoint reads the current acceptance ref itself, validates the
trusted signature and exact current main/tuple under its writer reservation,
then rechecks after generation and before completion. Main/ref movement rejects;
an interrupted build may leave an explicitly new partial output directory, never
overwrite a previous release. Git cannot be locked across arbitrary external
merges: this is point-in-time verification/rechecking, not a lease after return.
`main-acceptance.json` and the CLI result retain object/main/tuple digest binding
beside the normal release; it is not silently added to the nine-member manifest
or substituted for its provenance. Caller `provenance.sourceCommit` remains a
delivery declaration and is never used to certify main acceptance.

Without `--require-main` the existing synthetic checkpoint behavior is preserved
and makes no main-admission claim. The producer's synthetic-only guard remains.
Production use must require the flag in its separately reviewed delivery policy;
this increment does not enable real releases or bypass protected W publication.
