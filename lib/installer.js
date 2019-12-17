"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (Object.hasOwnProperty.call(mod, k)) result[k] = mod[k];
    result["default"] = mod;
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
// Load tempDirectory before it gets wiped by tool-cache
let tempDirectory = process.env['RUNNER_TEMPDIRECTORY'] || '';
const core = __importStar(require("@actions/core"));
const exec = __importStar(require("@actions/exec"));
const io = __importStar(require("@actions/io"));
const tc = __importStar(require("@actions/tool-cache"));
const httpClient = require("typed-rest-client/HttpClient");
const fs_1 = require("fs");
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const semver = __importStar(require("semver"));
const IS_WINDOWS = process.platform === 'win32';
if (!tempDirectory) {
    let baseLocation;
    if (IS_WINDOWS) {
        // On windows use the USERPROFILE env variable
        baseLocation = process.env['USERPROFILE'] || 'C:\\';
    }
    else {
        if (process.platform === 'darwin') {
            baseLocation = '/Users';
        }
        else {
            baseLocation = '/home';
        }
    }
    tempDirectory = path.join(baseLocation, 'actions', 'temp');
}
class DotnetCoreInstaller {
    constructor(version) {
        if (semver.valid(semver.clean(version) || '') == null) {
            throw 'Implicit version not permitted';
        }
        this.version = version;
        this.cachedToolName = 'dncs';
        this.arch = 'x64';
    }
    installDotnet() {
        return __awaiter(this, void 0, void 0, function* () {
            // Check cache
            let toolPath;
            let osSuffixes = yield this.detectMachineOS();
            let parts = osSuffixes[0].split('-');
            if (parts.length > 1) {
                this.arch = parts[1];
            }
            toolPath = this.getLocalTool();
            if (!toolPath) {
                // download, extract, cache
                console.log('Getting a download url', this.version);
                let downloadUrls = yield this.getDownloadUrls(osSuffixes, this.version);
                toolPath = yield this.downloadAndInstall(downloadUrls);
            }
            else {
                console.log('Using cached tool');
            }
            // Need to set this so that .NET Core global tools find the right locations.
            core.exportVariable('DOTNET_ROOT', toolPath);
            // Prepend the tools path. instructs the agent to prepend for future tasks
            core.addPath(toolPath);
        });
    }
    getLocalTool() {
        console.log('Checking tool cache');
        return tc.find(this.cachedToolName, this.version, this.arch);
    }
    detectMachineOS() {
        return __awaiter(this, void 0, void 0, function* () {
            let osSuffix = [];
            let output = '';
            let resultCode = 0;
            if (IS_WINDOWS) {
                let escapedScript = path
                    .join(__dirname, '..', 'externals', 'get-os-platform.ps1')
                    .replace(/'/g, "''");
                let command = `& '${escapedScript}'`;
                const powershellPath = yield io.which('powershell', true);
                resultCode = yield exec.exec(`"${powershellPath}"`, [
                    '-NoLogo',
                    '-Sta',
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Unrestricted',
                    '-Command',
                    command
                ], {
                    listeners: {
                        stdout: (data) => {
                            output += data.toString();
                        }
                    }
                });
            }
            else {
                let scriptPath = path.join(__dirname, '..', 'externals', 'get-os-distro.sh');
                fs_1.chmodSync(scriptPath, '777');
                const toolPath = yield io.which(scriptPath, true);
                resultCode = yield exec.exec(`"${toolPath}"`, [], {
                    listeners: {
                        stdout: (data) => {
                            output += data.toString();
                        }
                    }
                });
            }
            if (resultCode != 0) {
                throw `Failed to detect os with result code ${resultCode}. Output: ${output}`;
            }
            let index;
            if ((index = output.indexOf('Primary:')) >= 0) {
                let primary = output.substr(index + 'Primary:'.length).split(os.EOL)[0];
                osSuffix.push(primary);
            }
            if ((index = output.indexOf('Legacy:')) >= 0) {
                let legacy = output.substr(index + 'Legacy:'.length).split(os.EOL)[0];
                osSuffix.push(legacy);
            }
            if (osSuffix.length == 0) {
                throw 'Could not detect platform';
            }
            return osSuffix;
        });
    }
    downloadAndInstall(downloadUrls) {
        return __awaiter(this, void 0, void 0, function* () {
            let downloaded = false;
            let downloadPath = '';
            for (const url of downloadUrls) {
                try {
                    downloadPath = yield tc.downloadTool(url);
                    downloaded = true;
                    break;
                }
                catch (error) {
                    console.log('Could Not Download', url, JSON.stringify(error));
                }
            }
            if (!downloaded) {
                throw 'Failed to download package';
            }
            // extract
            console.log('Extracting Package', downloadPath);
            let extPath = IS_WINDOWS
                ? yield tc.extractZip(downloadPath)
                : yield tc.extractTar(downloadPath);
            // cache tool
            console.log('Caching tool');
            let cachedDir = yield tc.cacheDir(extPath, this.cachedToolName, this.version, this.arch);
            console.log('Successfully installed', this.version);
            return cachedDir;
        });
    }
    // OsSuffixes - The suffix which is a part of the file name ex- linux-x64, windows-x86
    // Type - SDK / Runtime
    // Version - Version of the SDK/Runtime
    getDownloadUrls(osSuffixes, version) {
        return __awaiter(this, void 0, void 0, function* () {
            let downloadUrls = [];
            const httpCallbackClient = new httpClient.HttpClient('actions/setup-dotnet', [], {});
            const releasesJsonUrl = yield this.getReleasesJsonUrl(httpCallbackClient, version.split('.'));
            let releasesJSON = yield httpCallbackClient.get(releasesJsonUrl);
            let releasesInfo = JSON.parse(yield releasesJSON.readBody())['releases'];
            releasesInfo = releasesInfo.filter((releaseInfo) => {
                return (releaseInfo['sdk']['version'] === version ||
                    releaseInfo['sdk']['version-display'] === version);
            });
            if (releasesInfo.length != 0) {
                let release = releasesInfo[0];
                let files = release['sdk']['files'];
                files = files.filter((file) => {
                    if (file['rid'] == osSuffixes[0] || file['rid'] == osSuffixes[1]) {
                        return (file['url'].endsWith('.zip') || file['url'].endsWith('.tar.gz'));
                    }
                });
                if (files.length > 0) {
                    files.forEach((file) => {
                        downloadUrls.push(file['url']);
                    });
                }
                else {
                    console.log(`The specified version's download links are not correctly formed in the supported versions document => ${releasesJsonUrl}`);
                }
            }
            if (downloadUrls.length == 0) {
                console.log(`Could not find download information for version, using fall back urls ${version}`);
                downloadUrls = yield this.getFallbackDownloadUrls(version);
            }
            if (downloadUrls.length == 0) {
                throw `Could not construct download URL. Please ensure that specified version ${version} is valid.`;
            }
            core.debug(`Got download urls ${downloadUrls}`);
            return downloadUrls;
        });
    }
    getReleasesJsonUrl(httpCallbackClient, versionParts) {
        return __awaiter(this, void 0, void 0, function* () {
            const releasesIndex = yield httpCallbackClient.get(DotNetCoreIndexUrl);
            let releasesInfo = JSON.parse(yield releasesIndex.readBody())['releases-index'];
            releasesInfo = releasesInfo.filter((info) => {
                // channel-version is the first 2 elements of the version (e.g. 2.1), filter out versions that don't match 2.1.x.
                const sdkParts = info['channel-version'].split('.');
                if (versionParts.length >= 2 && versionParts[1] != 'x') {
                    return versionParts[0] == sdkParts[0] && versionParts[1] == sdkParts[1];
                }
                return versionParts[0] == sdkParts[0];
            });
            if (releasesInfo.length === 0) {
                throw `Could not find info for version ${versionParts.join('.')} at ${DotNetCoreIndexUrl}`;
            }
            return releasesInfo[0]['releases.json'];
        });
    }
    getFallbackDownloadUrls(version) {
        return __awaiter(this, void 0, void 0, function* () {
            let primaryUrlSearchString;
            let legacyUrlSearchString;
            let output = '';
            let resultCode = 0;
            if (IS_WINDOWS) {
                let escapedScript = path
                    .join(__dirname, '..', 'externals', 'install-dotnet.ps1')
                    .replace(/'/g, "''");
                let command = `& '${escapedScript}' -Version ${version} -DryRun`;
                const powershellPath = yield io.which('powershell', true);
                resultCode = yield exec.exec(`"${powershellPath}"`, [
                    '-NoLogo',
                    '-Sta',
                    '-NoProfile',
                    '-NonInteractive',
                    '-ExecutionPolicy',
                    'Unrestricted',
                    '-Command',
                    command
                ], {
                    listeners: {
                        stdout: (data) => {
                            output += data.toString();
                        }
                    }
                });
                primaryUrlSearchString = 'dotnet-install: Primary named payload URL: ';
                legacyUrlSearchString = 'dotnet-install: Legacy named payload URL: ';
            }
            else {
                let escapedScript = path
                    .join(__dirname, '..', 'externals', 'install-dotnet.sh')
                    .replace(/'/g, "''");
                fs_1.chmodSync(escapedScript, '777');
                const scriptPath = yield io.which(escapedScript, true);
                resultCode = yield exec.exec(`"${scriptPath}"`, ['--version', version, '--dry-run'], {
                    listeners: {
                        stdout: (data) => {
                            output += data.toString();
                        }
                    }
                });
                primaryUrlSearchString = 'dotnet-install: Primary named payload URL: ';
                legacyUrlSearchString = 'dotnet-install: Legacy named payload URL: ';
            }
            if (resultCode != 0) {
                throw `Failed to get download urls with result code ${resultCode}. ${output}`;
            }
            let primaryUrl = '';
            let legacyUrl = '';
            if (!!output && output.length > 0) {
                let lines = output.split(os.EOL);
                // Fallback to \n if initial split doesn't work (not consistent across versions)
                if (lines.length === 1) {
                    lines = output.split('\n');
                }
                if (!!lines && lines.length > 0) {
                    lines.forEach((line) => {
                        if (!line) {
                            return;
                        }
                        var primarySearchStringIndex = line.indexOf(primaryUrlSearchString);
                        if (primarySearchStringIndex > -1) {
                            primaryUrl = line.substring(primarySearchStringIndex + primaryUrlSearchString.length);
                            return;
                        }
                        var legacySearchStringIndex = line.indexOf(legacyUrlSearchString);
                        if (legacySearchStringIndex > -1) {
                            legacyUrl = line.substring(legacySearchStringIndex + legacyUrlSearchString.length);
                            return;
                        }
                    });
                }
            }
            return [primaryUrl, legacyUrl];
        });
    }
}
exports.DotnetCoreInstaller = DotnetCoreInstaller;
const DotNetCoreIndexUrl = 'https://dotnetcli.blob.core.windows.net/dotnet/release-metadata/releases-index.json';
