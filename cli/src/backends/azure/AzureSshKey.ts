import { generateKeyPairSync } from "node:crypto"

// An OpenSSH wire-format string: uint32 length + bytes.
const sshString = (b: Buffer): Buffer => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length)
  return Buffer.concat([len, b])
}

// An mpint is a big-endian two's-complement integer: pad a leading 0x00 when
// the top bit is set so the value stays positive.
const sshMpint = (b: Buffer): Buffer =>
  sshString(
    b[0] !== undefined && b[0] & 0x80
      ? Buffer.concat([Buffer.from([0]), b])
      : b,
  )

/**
 * A fresh OpenSSH `ssh-rsa` public key whose private half is dropped on the
 * floor. Azure refuses a Linux VM without an admin credential, but nobody ever
 * signs in as that admin — `afk attach` goes through Microsoft Entra ID — so
 * the key exists only to be unusable. Non-deterministic: called by the shell,
 * its result injected into the pure Run Plan core.
 */
export const throwawayAdminPublicKey = (): string => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 3072 })
  const jwk = publicKey.export({ format: "jwk" })
  const e = Buffer.from(jwk.e ?? "", "base64url")
  const n = Buffer.from(jwk.n ?? "", "base64url")
  const blob = Buffer.concat([
    sshString(Buffer.from("ssh-rsa")),
    sshMpint(e),
    sshMpint(n),
  ])
  return `ssh-rsa ${blob.toString("base64")} afk-unused`
}
