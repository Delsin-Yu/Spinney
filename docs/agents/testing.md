# Testing convention

There is no automated test suite. Verification is manual: run in the Extension
Development Host (F5) and exercise read/write/exec against a scratch file
(`_e2e.txt` is a leftover scratch fixture, safe to ignore or delete). Before a
release, confirm `npm run compile` is clean and `build-deploy.ps1` succeeds.
