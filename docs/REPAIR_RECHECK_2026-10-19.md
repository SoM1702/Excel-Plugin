# Repair verification — 19 October 2026

## Result

112 backend tests and 117 frontend tests passed in the local environment. `git diff --check` passed. Application code and user workbooks were not edited during this review.

The seven earlier findings have implementation changes addressing them: percentage scaling, normalized header matching, category identity, request-local prediction warnings, numerical prediction errors, escaped manifest replacements, and fail-closed validation. Two remaining edge cases prevent an unconditional sign-off.

## P2: Literal category remains unavailable in the what-if form

Location: `addin/src/taskpane/taskpane.js:2224`.

The revised backend correctly preserves the literal category `_missing_` separately from actual missingness. An independent transformation probe produced three distinct vectors for `_missing_`, `\_missing\_`, and a blank. However, the frontend still skips every category whose text equals `_missing_`. The user cannot select this real category even though batch scoring supports it.

The empty option is also labelled “Missing / Default: [reference]”, although missingness now uses a separate indicator rather than the reference category.

### Repair

1. In `addin/src/taskpane/taskpane.js`, render every real entry in the current `all_train_categories` vocabulary, including `_missing_`.
2. Keep a separate blank option for true missingness; label it accurately as the missing-value bucket. Do not present it as equivalent to the reference category.
3. If supporting older model metadata, distinguish schema versions explicitly instead of guessing from category spelling.
4. In `addin/tests/taskpane.test.js`, test a schema containing both literal special names and actual missingness. Verify the option values and submitted payloads preserve each case.
5. Compare what-if and batch predictions for those inputs. Each must use the same encoding and probability for the same row.

## P2: Malformed signed numbers are silently accepted

Location: `backend/table_schema.py`, `try_parse_float`, both `lstrip("+-")` branches.

Independent probe results:

| Input | Current parsed result |
| --- | --- |
| `50%` | 0.5, correct |
| `--50%` | -0.5, should be rejected |
| `+-50` | 50.0, should be rejected |
| `++50` | 50.0, should be rejected |
| `-+50%` | -0.5, should be rejected |

`lstrip` removes any number of sign characters, not one optional sign. Invalid cells can silently become model inputs, and `+-50` even becomes positive.

### Repair

1. Define an explicit supported numeric grammar in `backend/table_schema.py`: at most one leading sign, a supported currency position if desired, a valid numeric body, and at most one trailing percent sign.
2. Reject repeated/mixed signs and repeated currency symbols rather than stripping them. Preserve valid scientific notation and negative percentages.
3. Add parser/preprocessor regression tests in `backend/tests/test_table_preprocessing.py` for malformed examples and valid `-50`, `+50`, `-12.5%`, `1e-3`, numeric zero, and numeric percentage values.
4. Add an API test proving a forced-numeric column containing malformed text returns an actionable validation error rather than training on the repaired-looking value.

## Remaining release gates

These tests were local automated tests, not a new live-Excel or hosted acceptance run. Authentication, model ownership, persistent storage, workload limits, clean Python 3.12/container execution, official manifest acceptance, and live Excel testing remain separate gates from the original deployment plan. The new XML parser is used directly by the build script but is currently only a transitive dependency; declaring it directly in package.json and the lockfile would improve dependency reliability.

After the two repairs, rerun both suites and manually compare what-if versus batch scoring in Excel. No public-readiness claim should be made solely from unit-test counts.
