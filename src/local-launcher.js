// Compatibility boundary for old saved campaigns and background tasks.
// All browser automation must now use an explicitly selected GoLogin profile.
export async function launchLocalBrowser() {
  throw new Error('Local Browser is no longer supported. Select a GoLogin profile and save the campaign again.');
}
export async function closeLocalBrowser() {}
