"""Independent reference implementation of contracts/crypto.md, used ONLY to generate golden vectors.

Deliberately shares no code or libraries with packages/crypto (TypeScript, @noble/*):
this uses pyca/cryptography for HKDF, AES-GCM, X25519 and secp256k1, and pycryptodome for keccak256.

Run: npm run golden:crypto   (writes tests/golden/crypto/crypto-vectors.json)

Golden vectors are frozen once reviewed (AGENTS.md rule 3). Regenerating must produce byte-identical
output; the script refuses to overwrite an existing file that differs.
"""

import hashlib
import json
import sys
from pathlib import Path

from Crypto.Hash import keccak
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

OUT = Path(__file__).with_name("crypto-vectors.json")
SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141


def hkdf(ikm: bytes, info: str | bytes, salt: bytes = b"engram.v1", length: int = 32) -> bytes:
    info_b = info.encode() if isinstance(info, str) else info
    return HKDF(algorithm=hashes.SHA256(), length=length, salt=salt, info=info_b).derive(ikm)


def keccak256(b: bytes) -> bytes:
    h = keccak.new(digest_bits=256)
    h.update(b)
    return h.digest()


def checksum(addr20: bytes) -> str:
    hex_addr = addr20.hex()
    h = keccak256(hex_addr.encode()).hex()
    return "0x" + "".join(c.upper() if int(h[i], 16) >= 8 else c for i, c in enumerate(hex_addr))


def account(prf: bytes) -> dict:
    counter = 0
    while True:
        k = hkdf(prf, f"engram.v1/account/secp256k1/{counter}")
        if 1 <= int.from_bytes(k, "big") < SECP256K1_N:
            break
        counter += 1
    priv = ec.derive_private_key(int.from_bytes(k, "big"), ec.SECP256K1())
    pub = priv.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    addr = keccak256(pub[1:])[-20:]
    return {"counter": counter, "accountKey": k.hex(), "publicKey": pub.hex(), "owner": checksum(addr), "_addr": addr}


def ns_id(prf: bytes, label: str) -> bytes:
    return hkdf(prf, f"engram.v1/nsid/{label}")


def ns_key(prf: bytes, label: str, epoch: int) -> bytes:
    return hkdf(prf, f"engram.v1/nskey/{label}/{epoch}")


def entry_aad(chain_id: int, registry: bytes, owner: bytes, nsid: bytes, epoch: int) -> bytes:
    return b"engram.v1/entry" + chain_id.to_bytes(32, "big") + registry + owner + nsid + epoch.to_bytes(8, "big")


def wrap_aad(chain_id: int, registry: bytes, owner: bytes, nsid: bytes, epoch: int, agent_id: int) -> bytes:
    return (b"engram.v1/wrap" + chain_id.to_bytes(32, "big") + registry + owner + nsid
            + epoch.to_bytes(8, "big") + agent_id.to_bytes(32, "big"))


def main() -> None:
    root_salt = hashlib.sha256(b"engram.prf.v1").digest()

    # RFC 5869 test case 1: proves the HKDF primitive itself is standard (hand-checkable against the RFC).
    rfc = HKDF(algorithm=hashes.SHA256(), length=42, salt=bytes.fromhex("000102030405060708090a0b0c"),
               info=bytes.fromhex("f0f1f2f3f4f5f6f7f8f9")).derive(bytes.fromhex("0b" * 22))
    assert rfc.hex() == ("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf"
                         "34007208d5b887185865"), "HKDF does not match RFC 5869"

    prfs = {"A": bytes([1]) * 32, "B": bytes([2]) * 32}
    labels = ["preferences", "work"]
    derivations = {}
    for name, prf in prfs.items():
        acc = account(prf)
        derivations[name] = {
            "prfOutput": prf.hex(),
            "account": {k: v for k, v in acc.items() if not k.startswith("_")},
            "nsId": {lb: ns_id(prf, lb).hex() for lb in labels},
            "nsKey": {lb: {str(e): ns_key(prf, lb, e).hex() for e in (0, 1)} for lb in labels},
        }

    prf = prfs["A"]
    owner = account(prf)["_addr"]
    chain_id = 10143
    registry = bytes.fromhex("11" * 20)
    label, epoch = "preferences", 0
    nsid, key = ns_id(prf, label), ns_key(prf, label, epoch)

    plaintext = b'{"v":1,"t":1790000000000,"kind":"preference","text":"vegetarian, allergic to peanuts"}'
    e_nonce = bytes([0x0A]) * 12
    e_aad = entry_aad(chain_id, registry, owner, nsid, epoch)
    entry_env = b"\x01" + e_nonce + AESGCM(key).encrypt(e_nonce, plaintext, e_aad)

    agent_priv = X25519PrivateKey.from_private_bytes(bytes([0x07]) * 32)
    agent_pub = agent_priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    eph_priv = X25519PrivateKey.from_private_bytes(bytes([0x0E]) * 32)
    eph_pub = eph_priv.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    shared = eph_priv.exchange(X25519PublicKey.from_public_bytes(agent_pub))
    kek = hkdf(shared, "engram.v1/wrap", salt=eph_pub + agent_pub)
    w_nonce = bytes([0x0B]) * 12
    agent_id = 7
    w_aad = wrap_aad(chain_id, registry, owner, nsid, epoch, agent_id)
    wrap_env = b"\x01" + eph_pub + w_nonce + AESGCM(kek).encrypt(w_nonce, key + label.encode(), w_aad)
    assert len(wrap_env) == 93 + len(label)

    vectors = {
        "_note": "Generated by tests/golden/crypto/generate_vectors.py (independent Python impl). FROZEN.",
        "spec": "contracts/crypto.md",
        "rootSalt": root_salt.hex(),
        "hkdfRfc5869Case1": rfc.hex(),
        "derivations": derivations,
        "context": {"chainId": chain_id, "registry": "0x" + registry.hex(), "owner": checksum(owner)},
        "entry": {
            "label": label, "epoch": epoch, "nsId": nsid.hex(), "nsKey": key.hex(),
            "nonce": e_nonce.hex(), "plaintext": plaintext.decode(), "aad": e_aad.hex(),
            "envelope": entry_env.hex(),
        },
        "wrap": {
            "label": label, "epoch": epoch, "agentId": agent_id,
            "agentX25519Private": (bytes([0x07]) * 32).hex(), "agentX25519Public": agent_pub.hex(),
            "ephemeralPrivate": (bytes([0x0E]) * 32).hex(), "ephemeralPublic": eph_pub.hex(),
            "sharedSecret": shared.hex(), "kek": kek.hex(), "nonce": w_nonce.hex(), "aad": w_aad.hex(),
            "envelope": wrap_env.hex(),
        },
    }
    text = json.dumps(vectors, indent=2) + "\n"
    if OUT.exists() and OUT.read_text() != text:
        sys.exit(f"refusing to overwrite frozen {OUT.name}: regenerated output differs (golden tests are frozen)")
    OUT.write_text(text)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
