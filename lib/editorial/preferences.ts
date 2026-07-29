import fs from "node:fs";
import path from "node:path";

import { normalizeCustomKeywords } from "./context";

type ReaderPreferences = {
  version: 1;
  keywords: string[];
  lockedAt: string;
};

export function readerPreferencesPath(): string {
  return process.env.DAILY_READER_PREFERENCES_PATH
    ? path.resolve(process.env.DAILY_READER_PREFERENCES_PATH)
    : path.resolve(".dailybrief", "reader-preferences.json");
}

export function loadReaderKeywords(): string[] {
  try {
    const value = JSON.parse(fs.readFileSync(readerPreferencesPath(), "utf8")) as Partial<ReaderPreferences>;
    return normalizeCustomKeywords(Array.isArray(value.keywords) ? value.keywords.map(String) : undefined);
  } catch {
    return [];
  }
}

export function saveReaderKeywords(input: string | string[]): ReaderPreferences {
  const keywords = normalizeCustomKeywords(input);
  const target = readerPreferencesPath();
  const preferences: ReaderPreferences = {
    version: 1,
    keywords,
    lockedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(preferences, null, 2), "utf8");
  fs.renameSync(temporary, target);
  return preferences;
}
