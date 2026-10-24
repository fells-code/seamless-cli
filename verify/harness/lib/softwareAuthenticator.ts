import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  randomBytes,
  sign,
} from 'crypto';

// A minimal ES256 authenticator with `fmt: 'none'` attestation, enough to enroll a
// passkey through the API without a browser. The browser layer covers the real
// navigator.credentials path with Playwright's virtual authenticator.

type Cbor = number | Uint8Array | string | Map<Cbor, Cbor>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

// Covers only what an attestation object and a COSE key need: small integers, byte
// strings, text strings and maps.
function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  }
  const entries = [...value.entries()].flatMap(([key, item]) => [cbor(key), cbor(item)]);
  return Buffer.concat([head(5, value.size), ...entries]);
}

function clientData(type: string, challenge: string, origin: string): Buffer {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
}

export class SoftwareAuthenticator {
  private readonly credentialId: Buffer;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;

  /**
   * With a seed, the key and credential id are derived from it, so a later process
   * (a Playwright worker restarted after a failure) can still sign for a passkey an
   * earlier one enrolled.
   */
  constructor(seed?: string) {
    if (!seed) {
      this.credentialId = randomBytes(32);
      ({ privateKey: this.privateKey, publicKey: this.publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
      }));
      return;
    }

    this.credentialId = createHash('sha256').update(`credential:${seed}`).digest();
    const d = createHash('sha256').update(`key:${seed}`).digest();
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    const point = ecdh.getPublicKey();
    this.privateKey = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: d.toString('base64url'),
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    this.publicKey = createPublicKey(this.privateKey);
  }

  get id() {
    return this.credentialId.toString('base64url');
  }

  register(params: { challenge: string; origin: string; rpId: string }) {
    const id = this.id;
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(params.rpId)],
      ]),
    );

    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientData('webauthn.create', params.challenge, params.origin).toString(
          'base64url',
        ),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
    };
  }

  /** An assertion for `navigator.credentials.get`, signed with this credential's key. */
  authenticate(params: { challenge: string; origin: string; rpId: string }) {
    const authenticatorData = Buffer.concat([
      createHash('sha256').update(params.rpId).digest(),
      Buffer.from([0x05]), // UP | UV
      this.signCount(),
    ]);
    const clientDataJSON = clientData('webauthn.get', params.challenge, params.origin);
    const signature = sign(
      'sha256',
      Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]),
      this.privateKey,
    );

    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authenticatorData.toString('base64url'),
        signature: signature.toString('base64url'),
      },
    };
  }

  // Seconds since the epoch, so it keeps increasing across processes sharing a seed,
  // and at least one past the last use, since the API refuses a count that does not grow.
  private signCount(): Buffer {
    this.counter = Math.max(Math.floor(Date.now() / 1000), this.counter + 1);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return counter;
  }

  private authData(rpId: string): Buffer {
    const counter = this.signCount();
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);

    return Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([0x45]), // UP | UV | AT
      counter,
      Buffer.alloc(16), // AAGUID: all zeroes, as an unattested authenticator reports
      idLength,
      this.credentialId,
      this.coseKey(),
    ]);
  }

  private coseKey(): Buffer {
    const { x, y } = this.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(x, 'base64url')],
        [-3, Buffer.from(y, 'base64url')],
      ]),
    );
  }
}
