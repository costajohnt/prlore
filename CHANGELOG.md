# Changelog

## [0.6.2](https://github.com/costajohnt/prlore/compare/v0.6.1...v0.6.2) (2026-11-08)


### Bug Fixes

* order extracted candidates by PR so rule ids don't depend on completion order ([#27](https://github.com/costajohnt/prlore/issues/27)) ([53ed557](https://github.com/costajohnt/prlore/commit/53ed5573a465f02725dc112265cc56bd345c3c27))

## [0.6.1](https://github.com/costajohnt/prlore/compare/v0.6.0...v0.6.1) (2026-11-08)


### Bug Fixes

* batch synthesis calls, detect truncated replies, and resume a failed synthesis ([#24](https://github.com/costajohnt/prlore/issues/24)) ([d192b19](https://github.com/costajohnt/prlore/commit/d192b19016568f762c6c1962fa5ac1b239ece275))
* cap recursive clustering, keep lower-level conflicts, and bound the synthesis cache ([#26](https://github.com/costajohnt/prlore/issues/26)) ([0ee79c2](https://github.com/costajohnt/prlore/commit/0ee79c28248ef43e60229c21ec5e014067e4f2da))
* re-running mine fetches PRs updated since the last run ([#23](https://github.com/costajohnt/prlore/issues/23)) ([9496996](https://github.com/costajohnt/prlore/commit/949699643ef016379ee090aed0b116598896fbd5))

## [0.6.0](https://github.com/costajohnt/prlore/compare/v0.5.1...v0.6.0) (2026-11-08)


### ⚠ BREAKING CHANGES

* prlore no longer writes the mined doc into AGENTS.md directly. It writes .prlore/AGENTS.md and a pointer block in AGENTS.md, and migrates an existing root managed block on the next write. The MCP preview output drops the `mode` field.

### Features

* fence untrusted PR text, flag weakly-bound rules, always write via pointer ([#22](https://github.com/costajohnt/prlore/issues/22)) ([4ad8235](https://github.com/costajohnt/prlore/commit/4ad8235f2d7215241126683125f376168c2a4ef5))


### Bug Fixes

* stop state writes from following symlinks in a mined checkout ([#20](https://github.com/costajohnt/prlore/issues/20)) ([2726eee](https://github.com/costajohnt/prlore/commit/2726eeeb98152259c8c594ab1ea2e6f06a3690b6))

## [0.5.1](https://github.com/costajohnt/prlore/compare/v0.5.0...v0.5.1) (2026-10-29)


### Bug Fixes

* **deps:** patch transitive dev advisories ([#14](https://github.com/costajohnt/prlore/issues/14)) ([7b13888](https://github.com/costajohnt/prlore/commit/7b13888159fdab6a15aa99f813c11f9bac549205))
* **deps:** patch zod and transitive production advisories ([#17](https://github.com/costajohnt/prlore/issues/17)) ([8ca6a9d](https://github.com/costajohnt/prlore/commit/8ca6a9df9f9f909bb3a8c9bad262115378d7409e))
* drop the default budget cap for claude-cli and stop extraction overshoot ([#16](https://github.com/costajohnt/prlore/issues/16)) ([8c149d7](https://github.com/costajohnt/prlore/commit/8c149d7e6697f076704a6880c4f2efb998fc8c50)), closes [#15](https://github.com/costajohnt/prlore/issues/15)
* handle claude CLI early exit and confine output.target to the repo ([#11](https://github.com/costajohnt/prlore/issues/11)) ([bfad5d6](https://github.com/costajohnt/prlore/commit/bfad5d691e900a61a262defbe5a6a91b4e800075)), closes [#9](https://github.com/costajohnt/prlore/issues/9) [#10](https://github.com/costajohnt/prlore/issues/10)
* isolate claude-cli provider and clear production audit advisories ([#8](https://github.com/costajohnt/prlore/issues/8)) ([319815e](https://github.com/costajohnt/prlore/commit/319815e7400a067a1abbb69538f97107eba7781d)), closes [#6](https://github.com/costajohnt/prlore/issues/6) [#7](https://github.com/costajohnt/prlore/issues/7)
* resolve fast-uri high-severity advisory (GHSA-7p8r-x3mc-p8w7) ([#5](https://github.com/costajohnt/prlore/issues/5)) ([41f54dc](https://github.com/costajohnt/prlore/commit/41f54dc9837b587d10e4d35ac78d53893eeb9ee3))
* resolve high-severity fast-uri advisory (GHSA-v2hh-gcrm-f6hx) ([f429f98](https://github.com/costajohnt/prlore/commit/f429f983f710da360afabd048645a9010fe4d914))
