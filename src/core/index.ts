export { scanLines, parseList, clampNumber, type LineInfo } from './markdown.js';
export {
	readingTime,
	readableText,
	countWords,
	formatReadingLabel,
	READING_DEFAULTS,
	type ReadingOptions,
	type ReadingResult,
} from './readingTime.js';
export {
	convertHeadings,
	convertHeadingText,
	TITLE_SMALL_WORDS,
	type HeadingCaseMode,
	type HeadingCaseOptions,
	type HeadingCaseResult,
	type HeadingChange,
} from './headingCase.js';
export { planZimImport, resolveZimLink, compareZimSources, validZimPath, ZIM_RULES, type ZimSource, type ZimRules, type ZimIssue, type ZimNote, type ZimPlan } from './zim.js';

export { spellFocusRange } from "./spellFocus.js";
export { findDescendants, descendantRoute, parentLinkTexts, type ParentNode, type ReachableNote } from './descendants.js';
export { markdownCsvTables, splitMarkdownCsvRow, encodeTableCsv, csvFileStem, TABLE_CSV_LIMIT, type MarkdownCsvTable, type TableCsvOptions } from './tableCsv.js';
export {
	compareVersions,
	decideHello,
	helloChatUrl,
	helloFeedbackUrl,
	helloPageUrl,
	isFeatureBump,
	normalizeHelloContent,
	readLastShown,
	shownRecently,
	HELLO_QUIET_DAYS,
	HELLO_SHARED_KEY,
	parseSemver,
	pluginPageUrl,
	readHelloState,
	safeHttpsUrl,
	HELLO_DATA_KEY,
	HELLO_DEFAULT_STATE,
	HELLO_LIMITS,
	HELLO_SITE,
	type HelloContent,
	type HelloDecision,
	type HelloInput,
	type HelloLastShown,
	type HelloReason,
	type HelloRelated,
	type HelloState,
} from './hello.js';
