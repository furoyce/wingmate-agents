import { randomUUID } from "node:crypto";
import { ulid } from "ulid";
export const newUlid = (): string => ulid();
export const newUuid = (): string => randomUUID();
export const IDENTIFIER_RE = /^[A-Z][A-Z0-9]{0,9}-\d+$/;
export const isIdentifier = (s: string): boolean => IDENTIFIER_RE.test(s);
