/**
 * GenerateExecutableHandler.ts
 *
 * Created on: 2016-09-25
 *     Author: Adrian Hintze @Rydion
 *
 */

'use strict';

import * as path from 'path';

import streamToArray = require('stream-to-array');

import SaxParser from './Xml';
import Zip from './Zip';
import Resolution from './Resolution';

import * as fileSystemUtils from './utils/FileSystem';
import * as validationUtils from './utils/Validation';

import logModule from './log/Log';

const moduleName = path.basename(__filename);
const log = logModule();
const resourcesDir = path.join(global.rootDir, '..', 'resources');
const unixExecutablePermissions = 0o0755;
const macToolbarCode =
`
var gui = require('nw.gui');
var win = gui.Window.get();
var menu = new gui.Menu({ type: 'menubar' });
menu.createMacBuiltin('<project_name>', {
    hideEdit: true,
    hideWindow: true
});
win.menu = menu;
var close = {
    key: 'Ctrl+q',
    active: function () { win.close(); }
};
var closeWindow = {
    key: 'Ctrl+w',
    active: function () { win.close(); }
};
var minimize = {
    key: 'Ctrl+m',
    active: function () { win.minimize(); }
};
var closeShortcut = new gui.Shortcut(close);
var closeWindowShortcut = new gui.Shortcut(closeWindow);
var minimizeShortcut = new gui.Shortcut(minimize);
gui.App.registerGlobalHotKey(closeShortcut);
gui.App.registerGlobalHotKey(closeWindowShortcut);
gui.App.registerGlobalHotKey(minimizeShortcut);
win.on('focus', function () {
    gui.App.registerGlobalHotKey(closeShortcut);
    gui.App.registerGlobalHotKey(closeWindowShortcut);
    gui.App.registerGlobalHotKey(minimizeShortcut);
});
win.on('blur', function () {
    gui.App.unregisterGlobalHotKey(closeShortcut);
    gui.App.unregisterGlobalHotKey(closeWindowShortcut);
    gui.App.unregisterGlobalHotKey(minimizeShortcut);
});
`;
const winFullscreenCode =
`
var gui = require('nw.gui');
var win = gui.Window.get();
var fullscreenShortcut = new gui.Shortcut({
    key: 'F11',
    active: function () { win.toggleFullscreen(); }
});
gui.App.registerGlobalHotKey(fullscreenShortcut);
`;

interface ErrorFeedback {
    message?: string;
    code?: string;
}

interface ExecGenerationRequestParams {
    filename: string;
    project: string;
    os: string;
    resolution: string;
    useCompleteSnap: boolean;
}

function validateFilename(filename: string): Promise<ErrorFeedback | void> {
    if (validationUtils.validateString(filename, false)) {
        return Promise.reject({ message: 'validateFilename1' });
    }

    return Promise.resolve();
}

function validateFileContents(fileContents: string): Promise<ErrorFeedback | void> {
    if (validationUtils.validateString(fileContents, false)) {
        return Promise.reject({ message: 'validateFileContents1' });
    }

    let hasProjectName: Boolean = false;
    const saxParser = new SaxParser();

    const returnPromise = new Promise((resolve, reject) => {
        saxParser.onError((error: Error) => reject({
            message: error.message,
            code: 'XML_VALIDATION_ERROR'
        }));

        saxParser.onTag((tag: any) => {
            const mainTagName = 'project';
            const nameAttributeName = 'name';
            if (tag.name === mainTagName) {
                hasProjectName = !!tag.attributes[nameAttributeName];
            }
        });

        saxParser.onEnd(() => {
            if (!hasProjectName) {
                reject({
                    message: 'Unable to find the project name.',
                    code: 'XML_PROPERTY_MISSING'
                });
                return;
            }

            resolve();
        });  
    });

    saxParser.parse(fileContents);

    return returnPromise;
}

function validateOs(os: string): Promise<ErrorFeedback | void> {
    const validOsValues = ['mac32', 'mac64', 'lin32', 'lin64', 'win32', 'win64'];
    if (validationUtils.validateString(os, false, validOsValues)) {
        return Promise.reject({ message: 'validateOs1' });
    }

    return Promise.resolve();
}

function validateResolution(resolution: string): Promise<ErrorFeedback | void> {
    if (validationUtils.validateString(resolution, false)) {
        return Promise.reject({ message: 'validateResolution1' });
    }

    try {
        Resolution.fromString(resolution);
        return Promise.resolve();
    }
    catch (error) {
        return Promise.reject({ message: 'validateResolution2' });
    }
}

function validateUseCompleteSnap(useCompleteSnap: boolean): Promise<ErrorFeedback | void> {
    if (validationUtils.validateBoolean(useCompleteSnap)) {
        return Promise.reject({ message: 'validateUseCompleteSnap1' });
    }

    return Promise.resolve();
}

function validateParams({ filename, project, os, resolution, useCompleteSnap }: ExecGenerationRequestParams): Promise<ErrorFeedback | void> {
    const validationPromises = [
        validateFilename(filename),
        validateFileContents(project),
        validateOs(os),
        validateResolution(resolution),
        validateUseCompleteSnap(useCompleteSnap)
    ];

    return Promise.all(validationPromises);
}

function getProjectName(fileContents: string): Promise<Error | string> {
    const saxParser = new SaxParser();

    const returnPromise = new Promise((resolve, reject) => {
        saxParser.onError((error: Error) => reject(error));

        saxParser.onTag((tag: any) => {
            const mainTagName = 'project';
            const nameAttributeName = 'name';
            if (tag.name === mainTagName) {
                resolve(tag.attributes[nameAttributeName]);
            }
        });

        saxParser.onEnd(() => resolve());
    });

    saxParser.parse(fileContents);

    return returnPromise;
}

function needsNodeMode(os: string): boolean {
    return os === 'mac32' || os === 'mac64' || os === 'win32' || os === 'win64';
}

function buildPackageJson(os: string, projectName: string, resolution: Resolution): string {
    return JSON.stringify({
        name: 'snapapp',
        main: 'snap.html',
        nodejs: needsNodeMode(os),
        'single-instance': true,
        window: {
            icon: 'lambda.png',
            title: projectName,
            toolbar: false,
            resizable: true,
            width: resolution.getWidth(),
            height: resolution.getHeight()
        }
    });
}

function buildGui(gui: string, project: string, os: string, projectName: string) {
    let result = gui + '\n';
    if (os === 'mac32' || os === 'mac64') {
        result += macToolbarCode.replace('<project_name>', projectName) + '\n';
    }
    if (os === 'win32' || os === 'win64') {
        result += winFullscreenCode + '\n';
    }
    return result + `IDE_Morph.prototype.snapproject = '${project}';`
}

function buildProjectPackage(projectPackage: Zip, project: string, os: string, projectName: string, resolution: Resolution, useCompleteSnap: boolean): Promise<Error | void> {
    const version = useCompleteSnap ? 'full' : 'reduced';

    projectPackage.append(buildPackageJson(os, projectName, resolution), { name: 'package.json' });
    projectPackage.directory(path.join(resourcesDir, 'snap', version, 'files'), '');

    return fileSystemUtils.readTextFile(path.join(resourcesDir, 'snap', version, 'gui', 'gui.js'))
    .then((gui: string) => {
        projectPackage.append(buildGui(gui, project, os, projectName), { name: 'gui.js' });
    })
    .catch((error: NodeJS.ErrnoException) => {
        log.error({ moduleName, message: 'Unable to read gui file.', meta: { version: version, errorCode: error.code } });
        throw error;
    });
}

function buildFinalPackage(finalPackage: Zip, os: string, projectName: string, filename: string): Promise<Error | void> {
    switch (os) {
        case 'mac64':
        case 'mac32': {
            const rootDir = `${projectName}.app`;

            finalPackage.directory(path.join(resourcesDir, 'nw', os, 'Contents'), path.join(rootDir, 'Contents'));
            finalPackage.file(path.join(resourcesDir, 'nw', os, 'bin', 'nwjs'), { name: path.join(rootDir, 'Contents', 'MacOS', 'nwjs'), mode: unixExecutablePermissions });
            finalPackage.file(path.join(resourcesDir, 'nw', os, 'bin', 'nwjs Helper'), { name: path.join(rootDir, 'Contents', 'Frameworks', 'nwjs Helper.app', 'Contents', 'MacOS', 'nwjs Helper'), mode: unixExecutablePermissions });
            finalPackage.file(path.join(resourcesDir, 'nw', os, 'bin', 'nwjs Helper EH'), { name: path.join(rootDir, 'Contents', 'Frameworks', 'nwjs Helper EH.app', 'Contents', 'MacOS', 'nwjs Helper EH'), mode: unixExecutablePermissions });
            finalPackage.file(path.join(resourcesDir, 'nw', os, 'bin', 'nwjs Helper NP'), { name: path.join(rootDir, 'Contents', 'Frameworks', 'nwjs Helper NP.app', 'Contents', 'MacOS', 'nwjs Helper NP'), mode: unixExecutablePermissions });
            finalPackage.file(path.join(resourcesDir, 'icons', 'lambda.icns'), { name: path.join(rootDir, 'Contents', 'Resources', 'nw.icns') });

            return fileSystemUtils.readTextFile(path.join(resourcesDir, 'conf', os, 'Info.plist'))
            .then((plistTemplate: string) => {
                const plist = plistTemplate.replace('<filename>', filename).replace('<short_filename>', filename.length < 16 ? filename : 'Snapp!');
                finalPackage.append(plist, { name: path.join(rootDir, 'Contents', 'Info.plist') });
            })
            .catch((error: NodeJS.ErrnoException) => {
                log.error({ moduleName, message: 'Unable to read mac Info.plist.', meta: { os, errorCode: error.code } });
                throw error;
            });
        }
        case 'lin64':
        case 'lin32': {
            const rootDir = `${projectName}.snapp`;

            finalPackage.directory(path.join(resourcesDir, 'nw', os, 'lib'), rootDir);
            finalPackage.file(path.join(resourcesDir, 'icons', 'lambda.png'), { name: path.join(rootDir, 'lambda.png') });

            const readFilesPromises: Array<Promise<Error | void>> = [
                fileSystemUtils.readTextFile(path.join(resourcesDir, 'conf', 'linux', 'launcher.sh'))
                .then((launcherTemplate: string) => {
                    const launcher = launcherTemplate.replace('<filename>', filename);
                    finalPackage.append(launcher, { name: path.join(rootDir, 'launcher.sh'), mode: unixExecutablePermissions });
                })
                .catch((error: NodeJS.ErrnoException) => {
                    log.error({ moduleName, message: 'Unable to read linux launcher.sh.', meta: { os, errorCode: error.code } });
                    throw error;
                }),
                fileSystemUtils.readTextFile(path.join(resourcesDir, 'conf', 'linux', 'app.desktop'))
                .then((launcherTemplate: string) => {
                    const launcher = launcherTemplate.replace('<filename>', filename);
                    finalPackage.append(launcher, { name: `${filename}.desktop`, mode: unixExecutablePermissions });
                })
                .catch((error: NodeJS.ErrnoException) => {
                    log.error({ moduleName, message: 'Unable to read linux app.desktop.', meta: { os, errorCode: error.code } });
                })
            ];

            return Promise.all(readFilesPromises).then(() => { return; });
        }
        case 'win64':
        case 'win32':
            finalPackage.directory(path.join(resourcesDir, 'nw', os, 'lib'), filename);
            return Promise.resolve();
        default:
            log.error({ moduleName, message: 'Invalid os.', meta: { os } });
            return Promise.reject(new Error('Invalid os.'));
    }
}

function buildPackages(params: ExecGenerationRequestParams): Promise<Error | NodeJS.ReadableStream> {
    const { project, os, resolution: res, useCompleteSnap, filename } = params;
    const resolution = Resolution.fromString(res);

    return getProjectName(project)
    .then((projectName: string) => {
        return new Promise<Error | NodeJS.ReadableStream>((resolve, reject) => {
            const finalPackage: Zip = new Zip(
                (error: Error) => reject(error),
                () => log.info({ moduleName, message: 'Final package finished.' })
            );

            const nwPackage: Zip = new Zip((error: any) => reject(error), () => {
                streamToArray(nwPackage.getStream())
                .then((parts: Array<Buffer>) => {
                    const buffer = Buffer.concat(parts);
                    switch (os) {
                        case 'mac64':
                        case 'mac32':
                            finalPackage
                            .append(buffer, { name: path.join(`${projectName}.app`, 'Contents', 'Resources', 'app.nw'), mode: unixExecutablePermissions })
                            .finalize();
                            break;
                        case 'lin64':
                        case 'lin32':
                            fileSystemUtils.readFile(path.join(resourcesDir, 'nw', os, 'bin', 'nw'))
                            .then((file: Buffer) => {
                                finalPackage
                                .append(Buffer.concat([file, buffer]), { name: path.join(`${projectName}.snapp`, filename), mode: unixExecutablePermissions })
                                .finalize();
                            })
                            .catch((error: NodeJS.ErrnoException) => reject(error));
                            break;
                        case 'win64':
                        case 'win32': {
                            fileSystemUtils.readFile(path.join(resourcesDir, 'nw', os, 'exe', 'nw.exe'))
                            .then((file: Buffer) => {
                                finalPackage
                                .append(Buffer.concat([file, buffer]), { name: path.join(filename, `${filename}.exe`) })
                                .finalize();
                            })
                            .catch((error: NodeJS.ErrnoException) => reject(error));
                            break;
                        }
                        default:
                            log.error({ moduleName, message: 'Invalid os.', meta: { os } });
                            reject(new Error('Invalid os.'));
                    }
                })
                .catch((error: Error) => {
                    log.error({ moduleName, message: 'Error arraying nwPackage.', meta: { error: log.destructureError(error) } });
                    reject(error);
                });
            });

            buildProjectPackage(nwPackage, project, os, projectName, resolution, useCompleteSnap)
            .then(() => buildFinalPackage(finalPackage, os, projectName, filename))
            .then(() => {
                nwPackage.finalize();
                resolve(finalPackage.getStream());
            })
            .catch((error: Error) => reject(error));
        });
    });
}

function loadProject(projectPath: string): Promise<NodeJS.ErrnoException | string> {
    return fileSystemUtils
    .readTextFile(projectPath)
    .then((project: string) => project.replace(/\r?\n|\r/g, '').replace(/'/g, "\\'")); // Remove end of line and escape single quotes
}

export default function handleExecGeneration(projectPath: string, params: ExecGenerationRequestParams): Promise<NodeJS.ErrnoException | Error | NodeJS.ReadableStream> {
    return loadProject(projectPath)
    .then((project: string) => {
        params.project = project;

        return validateParams(params)
        .then(() => buildPackages(params))
        .catch((validationError: ErrorFeedback) => {
            const { message = '', code = '' } = validationError;
            const errorMessage = `Error validating parameters: ${message}.`;
            throw {
                code,
                error: new Error(errorMessage),
                status: 400
            };
        });
    });
}
