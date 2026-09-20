# Third-party notices

Original project code is MIT licensed (see LICENSE). Dependencies retain their own copyright and license. No market data or user databases are licensed or distributed by this project.

The Windows package includes Node.js v24.15.0 and its license at runtime/LICENSE. This source snapshot also retains that full notice in third-party/node/LICENSE-v24.15.0.txt. Production dependency license texts are retained under third-party/npm and in the installed packages. KLineChart Apache-2.0 NOTICE includes TradingView attribution; Lucide includes Feather MIT and Lucide ISC terms.

The complete production dependency inventory is [dependencies.json](third-party/dependencies.json). It preserves package versions, declared license identifiers and notice locations.

## TongDaXin gbbq compatibility table

`server/src/tdx/gbbq.ts` contains a fixed 4,176-byte decoding table matching [pytdx's reader](https://github.com/rainx/pytdx/blob/2857fdad08534533610bd2aeca387f760c4baa42/pytdx/reader/gbbq_reader.py) by rainx and contributors. Its decoded SHA-256 is `2cdbe88a76fd70bdb3338d1cf5e2400e16412994c8cf5e1eafbefe2dcabd2e45`.

No separate upstream redistribution license was identified for this table. The [upstream author's licensing statement](https://github.com/rainx/pytdx/issues/64#issuecomment-337083057) is retained as provenance. This project's MIT declaration covers its own contributions and does not assert that the upstream table has independently received an MIT grant. TongDaXin and its data remain third-party materials.
