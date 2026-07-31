const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

exports.default = async (context) => {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const rceditPath = process.env.ZX_WALLPAPER_RCEDI_PATH;
  if (!rceditPath) {
    throw new Error(
      "ZX_WALLPAPER_RCEDI_PATH is required for Windows packaging.",
    );
  }

  const executablePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  );
  const iconPath = path.join(
    context.packager.projectDir,
    "build",
    "zx-wallpaper.ico",
  );
  await execFileAsync(rceditPath, [executablePath, "--set-icon", iconPath]);
};
