/**
 * build/notarize.cjs — the electron-builder afterSign hook (file 10 §4.1).
 *
 * electron-builder (hardenedRuntime:true) already deep-signs the app + every Mach-O
 * in extraResources (the bundled python interpreter + its dylibs) with our Developer
 * ID. This hook then notarizes + (electron-builder staples the dmg post-notarize).
 *
 * Skips gracefully off-mac and when the Apple credentials are absent (a local /
 * unsigned build), so it never breaks a dev `electron-builder` run — notarization is
 * a release-CI concern gated by the APPLE_* secrets.
 */
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/** An Apple app-specific password is exactly `xxxx-xxxx-xxxx-xxxx` (lower-case letters). */
const APP_PASSWORD_RE = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/;

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  if (electronPlatformName !== "darwin") return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    // A SKIP is a valid outcome (local/unsigned build) — but LOUD, never a silent pass that
    // could masquerade as "notarized". A fake success log here is worse than an honest skip.
    console.log(
      "notarize: SKIP — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set " +
        "(unsigned local build; Gatekeeper will quarantine on first open of a downloaded copy).",
    );
    return;
  }
  // A regular Apple-ID password (not the 16-char app-specific one) returns a misleading
  // HTTP 401 "unable to authenticate" from notarytool — catch it here with a clear message.
  if (!APP_PASSWORD_RE.test(APPLE_APP_SPECIFIC_PASSWORD)) {
    console.warn(
      "notarize: WARNING — APPLE_APP_SPECIFIC_PASSWORD is not in the xxxx-xxxx-xxxx-xxxx form; " +
        "notarytool will 401 unless this is an app-specific password (appleid.apple.com → Sign-In & Security).",
    );
  }

  // Loaded lazily so a non-mac / non-release build needs no @electron/notarize install.
  const { notarize } = require("@electron/notarize");
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`notarize: submitting ${appPath} via notarytool …`);
  await notarize({
    tool: "notarytool", // altool submission was retired by Apple (Nov 2023) — notarytool only.
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  // notarytool accepts the ticket but does NOT staple it — do that here so the .app validates
  // OFFLINE (Gatekeeper on a machine with no network). `codesign --verify` alone does NOT prove
  // notarization; `stapler validate` (and `spctl` in CI) is the real proof.
  try {
    execFileSync("xcrun", ["stapler", "staple", appPath], { stdio: "inherit" });
    execFileSync("xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
    console.log("notarize: stapled + validated ✓");
  } catch (e) {
    // A staple failure is fatal for a release (an un-stapled app fails offline Gatekeeper).
    throw new Error(`notarize: stapler failed — ${e.message}`);
  }
};
