export function createId(): string {
  const cryptoObject = globalThis.crypto as Crypto | undefined;
  if (cryptoObject?.randomUUID) {
    return cryptoObject.randomUUID();
  }

  return `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDeviceId(): string {
  return createId();
}
