# Third-Party Notices

This project is licensed under the MIT License (see `LICENSE`). It depends on the
third-party packages below, each under its own licence. No third-party source code has
been copied into this repository.

---

## Provenance audit of this repository's own source

Audited before release:

- **All TypeScript under `src/` and `config/` is original work** written for this project.
- **No Solidity source is included.** Contract behaviour is described in documentation and
  exercised through ABI fragments; no protocol contract source was copied.
- **No code was copied or adapted from Vibe/Vibe, Seedify, Robinhood, or any third-party
  repository.**

### A note on the ABI fragments in `config/abis.ts`

These describe the external interfaces of contracts deployed on a public blockchain. They
were established by:

1. observing the public frontend bundle served by the operator's web application, and
2. extracting function selectors from deployed runtime bytecode and resolving them against
   the public 4byte directory, then
3. confirming each one with a live `eth_call` or by decoding a live event log.

Function signatures and event signatures are **interface facts about deployed bytecode**, the
information required to interoperate with a public contract. They are not creative works, and
they are recorded here only to the extent needed to read public chain data. Names such as
`isSeedifyToken` or `Seedify Mock Stock SPCX` appear because they are the literal identifiers
present in deployed bytecode and on-chain token metadata.

No claim of ownership is made over any protocol interface, and no endorsement or affiliation
is implied. If any rights holder considers a fragment here to be inappropriately included,
please open an issue and it will be removed.

---

## Runtime dependencies

### viem
- **Licence:** MIT
- **Homepage:** https://github.com/wevm/viem
- Copyright (c) 2023-present weth, LLC.
- Used for: RPC client, ABI encoding/decoding, log parsing, multicall.

### dotenv
- **Licence:** BSD-2-Clause
- **Homepage:** https://github.com/motdotla/dotenv
- Copyright (c) 2015, Scott Motte. All rights reserved.
- Used for: loading `.env` configuration.

> BSD-2-Clause requires that the above copyright notice, this list of conditions and the
> following disclaimer are retained in redistributions:
>
> Redistribution and use in source and binary forms, with or without modification, are
> permitted provided that the following conditions are met:
> 1. Redistributions of source code must retain the above copyright notice, this list of
>    conditions and the following disclaimer.
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of
>    conditions and the following disclaimer in the documentation and/or other materials
>    provided with the distribution.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
> EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
> MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE
> COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
> EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
> SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
> HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
> TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
> SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

---

## Development dependencies

Not distributed with the package; listed for completeness.

| Package | Licence |
|---|---|
| typescript | Apache-2.0 |
| tsx | MIT |
| @types/node | MIT |

TypeScript is Apache-2.0, which is compatible with MIT for this use. It is a build-time tool
and its source is not redistributed here.

---

## Licence compatibility summary

| Licence | Packages | MIT-compatible |
|---|---|---|
| MIT | viem, tsx, @types/node | yes |
| BSD-2-Clause | dotenv | yes, notice retained above |
| Apache-2.0 | typescript (dev only) | yes |

No copyleft (GPL/AGPL/LGPL) dependency is present in the tree. `npm audit` reported
**0 vulnerabilities** across 16 production and 31 development dependencies at the time of the
release audit.
