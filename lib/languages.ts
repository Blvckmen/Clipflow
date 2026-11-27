// Languages a clip can be translated into for an account (account option subtitleLanguage). "en" is the clip as
// captured (no translation). The worker's translator uses the names.
export const subtitleLanguages = { en: "English (as captured)", es: "Spanish", pt: "Portuguese (Brazil)", fr: "French" } as const;
export type SubtitleLanguage = keyof typeof subtitleLanguages;
export const translatable = (lang: string | null | undefined): lang is Exclude<SubtitleLanguage, "en"> => lang === "es" || lang === "pt" || lang === "fr";
