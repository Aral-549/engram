"""Independent reference for the Disclosure-mode additions to contracts/crypto.md (cases 17-21):
pairwise identity keys and canonical v2 entry documents. Shares no code with packages/crypto.

Run: uv run --with cryptography==45.0.7 --with pycryptodome==3.23.0 tests/golden/crypto/generate_vectors_v2.py
Writes tests/golden/crypto/crypto-vectors-v2.json. Frozen once reviewed: refuses to overwrite a differing file.
"""

import json
import sys
from pathlib import Path

from Crypto.Hash import keccak
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

OUT = Path(__file__).with_name("crypto-vectors-v2.json")
SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def hkdf(ikm: bytes, info: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=b"engram.v1", info=info.encode()).derive(ikm)


def keccak256(b: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(b)
    return h.digest()


def checksum(addr20: bytes) -> str:
    hex_addr = addr20.hex()
    h = keccak256(hex_addr.encode()).hex()
    return "0x" + "".join(c.upper() if int(h[i], 16) >= 8 else c for i, c in enumerate(hex_addr))


def secp_account(prf: bytes, prefix: str) -> dict:
    counter = 0
    while True:
        k = hkdf(prf, f"{prefix}{counter}")
        if 1 <= int.from_bytes(k, "big") < SECP256K1_N:
            break
        counter += 1
    priv = ec.derive_private_key(int.from_bytes(k, "big"), ec.SECP256K1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return {"counter": counter, "key": k.hex(), "address": checksum(keccak256(pub[1:])[-20:])}


def pairwise(prf: bytes, agent_id: int) -> dict:
    return secp_account(prf, f"engram.v1/pairwise/secp256k1/{agent_id}/")


def canon(doc: dict) -> str:
    # Same as JS JSON.stringify for these inputs: insertion-ordered keys, no whitespace, no ASCII escaping.
    return json.dumps(doc, separators=(",", ":"), ensure_ascii=False)


def main() -> None:
    prf1 = bytes([1]) * 32
    prf2 = bytes([2]) * 32
    vectors = {
        "pairwise": [
            {"prf": prf1.hex(), "agentId": "7", **pairwise(prf1, 7)},
            {"prf": prf1.hex(), "agentId": "8", **pairwise(prf1, 8)},
            {"prf": prf1.hex(), "agentId": "1965", **pairwise(prf1, 1965)},
            {"prf": prf2.hex(), "agentId": "7", **pairwise(prf2, 7)},
        ],
        "account_prf1": secp_account(prf1, "engram.v1/account/secp256k1/"),
        "entries_v2": [
            canon({"v": 2, "t": 1790000000000, "kind": "preference", "text": "prefers window seats", "src": {"agent": "7"}}),
            canon({"v": 2, "t": 1790000000001, "kind": "fact", "text": "शाकाहारी, 花生アレルギー", "src": {"agent": "1965"}}),
            canon({"v": 2, "t": 1790000000002, "kind": "policy", "agent": "7", "origin": "https://app.x", "labels": ["preferences", "travel"],
                   "scope": "read", "exp": 1790604800000, "active": True}),
            canon({"v": 2, "t": 1790000000003, "kind": "policy", "agent": "7", "origin": "http://localhost:3202", "labels": ["preferences"],
                   "scope": "readwrite", "exp": 0, "active": False}),
            canon({"v": 2, "t": 1790000000004, "kind": "log", "agent": "7", "origin": "https://app.x", "q": "Plan dinner, any allergy concerns?",
                   "mode": "relevant", "refs": [{"l": "preferences", "s": "1"}], "n": 1, "round": 0}),
            canon({"v": 2, "t": 1790000000005, "kind": "log", "agent": "8", "origin": "https://app.x", "q": "", "mode": "full", "refs": [], "n": 0, "round": 3}),
        ],
    }
    text = json.dumps(vectors, indent=2, ensure_ascii=False) + "\n"
    if OUT.exists() and OUT.read_text() != text:
        sys.exit(f"{OUT.name} exists and differs; golden vectors are frozen (AGENTS.md rule 3)")
    OUT.write_text(text)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
