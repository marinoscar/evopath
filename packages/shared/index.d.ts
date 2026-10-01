/**
 * Type declarations for `@app/shared`, hand-written because this package has no
 * build step (see the long note at the top of `index.js` for why).
 *
 * Deliberately typed as `string` and NOT as the string literal. A literal type
 * would let a consumer — or, more likely, a test — depend on the current VALUE
 * at the type level, so renaming the app would turn into a typecheck failure
 * somewhere far away from this package. The whole point is that the value is
 * free to change.
 */
export declare const APP_NAME: string;

/**
 * Typed `string`, not `'#1976d2'`, for the same reason as `APP_NAME` above: a
 * literal type would let a consumer or a test pin the current colour at the
 * type level, and rebranding a fork would then fail the typecheck in some file
 * that has nothing to do with this package.
 */
export declare const THEME_COLOR: string;

/** Typed `string`, not a literal — see the note on `THEME_COLOR`. */
export declare const BACKGROUND_COLOR: string;

/**
 * The brand mark's sun. A LOGO-ONLY colour, never a UI colour (see `index.js`).
 *
 * Typed `string`, not a literal — see the note on `THEME_COLOR`.
 */
export declare const ACCENT_COLOR: string;

/**
 * `APP_NAME` as a lowercase hyphenated token (`'Some Name'` -> `'some-name'`), for
 * the contexts where spaces and capitals are wrong.
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const APP_SLUG: string;

/**
 * The GitHub repository, as `owner/name`. A separate fact from `APP_NAME`.
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const REPO_SLUG: string;

/**
 * The repository's canonical HTTPS URL, derived from `REPO_SLUG`.
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const REPO_URL: string;

/**
 * The repository's name (`REPO_SLUG` after the slash), case preserved.
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const REPO_NAME: string;

/**
 * The Android app's applicationId, `com.<repo name, lowercased, alphanumerics only>.android`.
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const ANDROID_PACKAGE_NAME: string;

/**
 * The Android app's deep-link scheme, `<repo name, lowercased>-android`.
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const ANDROID_DEEP_LINK_SCHEME: string;

/**
 * The stem of the Android APK file names, `<repo name>-android`
 * (`<stem>-<versionName>.apk`, `<stem>.apk` for the GitHub release asset).
 *
 * Typed `string`, not a literal — see the note on `APP_NAME`.
 */
export declare const ANDROID_APK_STEM: string;
