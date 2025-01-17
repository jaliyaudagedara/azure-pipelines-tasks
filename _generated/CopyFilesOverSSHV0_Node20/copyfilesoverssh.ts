import * as os from 'os';
import * as path from 'path';
import * as tl from 'azure-pipelines-task-lib/task';
import * as minimatch from 'minimatch';
import * as utils from './utils';
import { SshHelper } from './sshhelper';
import Queue, { QueueEvents } from './queue';

// This method will find the list of matching files for the specified contents
// This logic is the same as the one used by CopyFiles task except for allowing dot folders to be copied
// This will be useful to put in the task-lib
function getFilesToCopy(sourceFolder: string, contents: string[]): string[] {
    // include filter
    const includeContents: string[] = [];
    // exclude filter
    const excludeContents: string[] = [];

    // evaluate leading negations `!` on the pattern
    for (const pattern of contents.map(x => x.trim())) {
        let negate: boolean = false;
        let numberOfNegations: number = 0;
        for (const c of pattern) {
            if (c === '!') {
                negate = !negate;
                numberOfNegations++;
            } else {
                break;
            }
        }

        if (negate) {
            tl.debug('exclude content pattern: ' + pattern);
            const realPattern = pattern.substring(0, numberOfNegations) + path.join(sourceFolder, pattern.substring(numberOfNegations));
            excludeContents.push(realPattern);
        } else {
            tl.debug('include content pattern: ' + pattern);
            const realPattern = path.join(sourceFolder, pattern);
            includeContents.push(realPattern);
        }
    }

    // enumerate all files
    let files: string[] = [];
    const allPaths: string[] = tl.find(sourceFolder);
    const allFiles: string[] = [];

    // remove folder path
    for (const p of allPaths) {
        if (!tl.stats(p).isDirectory()) {
            allFiles.push(p);
        }
    }

    // if we only have exclude filters, we need add a include all filter, so we can have something to exclude.
    if (includeContents.length === 0 && excludeContents.length > 0) {
        includeContents.push('**');
    }

    tl.debug("counted " + allFiles.length + " files in the source tree");

    // a map to eliminate duplicates
    const pathsSeen = {};

    // minimatch options
    const matchOptions: tl.MatchOptions = { matchBase: true, dot: true };
    if (os.platform() === 'win32') {
        matchOptions.nocase = true;
    }

    // apply include filter
    for (const pattern of includeContents) {
        tl.debug('Include matching ' + pattern);

        // let minimatch do the actual filtering
        const matches: string[] = minimatch.match(allFiles, pattern, matchOptions);

        tl.debug('Include matched ' + matches.length + ' files');
        for (const matchPath of matches) {
            if (!pathsSeen.hasOwnProperty(matchPath)) {
                pathsSeen[matchPath] = true;
                files.push(matchPath);
            }
        }
    }

    // apply exclude filter
    for (const pattern of excludeContents) {
        tl.debug('Exclude matching ' + pattern);

        // let minimatch do the actual filtering
        const matches: string[] = minimatch.match(files, pattern, matchOptions);

        tl.debug('Exclude matched ' + matches.length + ' files');
        files = [];
        for (const matchPath of matches) {
            files.push(matchPath);
        }
    }

    return files;
}

function prepareFiles(filesToCopy: string[], sourceFolder: string, targetFolder: string, flattenFolders: boolean) {
    return filesToCopy.map(x => {
        let targetPath = path.posix.join(
            targetFolder,
            flattenFolders
                ? path.basename(x)
                : x.substring(sourceFolder.length).replace(/^\\/g, "").replace(/^\//g, "")
        );

        if (!path.isAbsolute(targetPath) && !utils.pathIsUNC(targetPath)) {
            targetPath = `./${targetPath}`;
        }

        return [x, utils.unixyPath(targetPath)];
    });
}

function getUniqueFolders(filesToCopy: string[]) {
    const foldersSet = new Set<string>();

    for (const filePath of filesToCopy) {
        const folderPath = path.dirname(filePath);

        if (foldersSet.has(folderPath)) {
            continue;
        }

        foldersSet.add(folderPath);
    }

    return Array.from(foldersSet.values());
}

async function newRun() {
    tl.setResourcePath(path.join(__dirname, 'task.json'));

    // Read SSH endpoint input
    const sshEndpoint = tl.getInput('sshEndpoint', true);
    const username = tl.getEndpointAuthorizationParameter(sshEndpoint, 'username', false);
    // Passphrase is optional
    const password = tl.getEndpointAuthorizationParameter(sshEndpoint, 'password', true);
    // Private key is optional, password can be used for connecting
    const privateKey = process.env['ENDPOINT_DATA_' + sshEndpoint + '_PRIVATEKEY'];
    const hostname = tl.getEndpointDataParameter(sshEndpoint, 'host', false);
    // Port is optional, will use 22 as default port if not specified
    let port = tl.getEndpointDataParameter(sshEndpoint, 'port', true);

    if (!port) {
        console.log(tl.loc('UseDefaultPort'));
        port = '22';
    }

    const readyTimeout = parseInt(tl.getInput('readyTimeout', true), 10);
    const useFastPut = !(process.env['USE_FAST_PUT'] === 'false');
    const concurrentUploads = parseInt(tl.getInput('concurrentUploads'));

    // Set up the SSH connection configuration based on endpoint details
    let sshConfig: Object = {
        host: hostname,
        port: port,
        username: username,
        readyTimeout: readyTimeout,
        useFastPut: useFastPut,
        promiseLimit: isNaN(concurrentUploads) ? 10 : concurrentUploads
    };

    if (privateKey) {
        tl.debug('Using private key for ssh connection.');

        sshConfig = {
            ...sshConfig,
            privateKey,
            passphrase: password
        }
    } else {
        // Use password
        tl.debug('Using username and password for ssh connection.');

        sshConfig = {
            ...sshConfig,
            password,
        }
    }

    // Contents is a multiline input containing glob patterns
    const contents = tl.getDelimitedInput('contents', '\n', true);
    const sourceFolder = tl.getPathInput('sourceFolder', true, true);
    let targetFolder = tl.getInput('targetFolder');

    if (!targetFolder) {
        targetFolder = "./";
    } else {
        // '~/' is unsupported
        targetFolder = targetFolder.replace(/^~\//, "./");
    }

    // Read the copy options
    const cleanTargetFolder = tl.getBoolInput('cleanTargetFolder', false);
    const overwrite = tl.getBoolInput('overwrite', false);
    const failOnEmptySource = tl.getBoolInput('failOnEmptySource', false);
    const flattenFolders = tl.getBoolInput('flattenFolders', false);

    if (!tl.stats(sourceFolder).isDirectory()) {
        tl.setResult(tl.TaskResult.Failed, tl.loc('SourceNotFolder'));
        return;
    }

    // Initialize the SSH helpers, set up the connection
    const sshHelper = new SshHelper(sshConfig);
    await sshHelper.setupConnection();

    if (cleanTargetFolder && await sshHelper.checkRemotePathExists(targetFolder)) {
        console.log(tl.loc('CleanTargetFolder', targetFolder));
        const isWindowsOnTarget = tl.getBoolInput('isWindowsOnTarget', false);
        const cleanHiddenFilesInTarget = tl.getBoolInput('cleanHiddenFilesInTarget', false);
        const cleanTargetFolderCmd = utils.getCleanTargetFolderCmd(targetFolder, isWindowsOnTarget, cleanHiddenFilesInTarget);

        try {
            await sshHelper.runCommandOnRemoteMachine(cleanTargetFolderCmd, null);
        } catch (error) {
            tl.setResult(tl.TaskResult.Failed, tl.loc('CleanTargetFolderFailed', error));
            tl.debug('Closing the client connection');
            await sshHelper.closeConnection();
            return;
        }
    }

    // If the contents were parsed into an array and the first element was set as default "**",
    // then upload the entire directory
    if (contents.length === 1 && contents[0] === "**") {
        tl.debug("Upload a directory to a remote machine");

        try {
            const completedDirectory = await sshHelper.uploadFolder(sourceFolder, targetFolder);
            tl.setResult(tl.TaskResult.Succeeded, tl.loc('CopyDirectoryCompleted', completedDirectory));
        } catch (error) {
            tl.setResult(tl.TaskResult.Failed, tl.loc("CopyDirectoryFailed", sourceFolder, error));
        }

        tl.debug('Closing the client connection');
        await sshHelper.closeConnection();
        return;
    }

    // Identify the files to copy
    const filesToCopy = getFilesToCopy(sourceFolder, contents);

    // Copy files to remote machine
    if (filesToCopy.length === 0) {
        if (failOnEmptySource) {
            tl.setResult(tl.TaskResult.Failed, tl.loc('NothingToCopy'));
            return;
        } else {
            tl.warning(tl.loc('NothingToCopy'));
            return;
        }
    }

    const preparedFiles = prepareFiles(filesToCopy, sourceFolder, targetFolder, flattenFolders);

    tl.debug(`Number of files to copy = ${preparedFiles.length}`);
    tl.debug(`filesToCopy = ${preparedFiles}`);

    console.log(tl.loc('CopyingFiles', preparedFiles.length));

    // Create remote folders structure
    const folderStructure = getUniqueFolders(preparedFiles.map(x => x[1]).sort());

    for (const foldersPath of folderStructure) {
        try {
            await sshHelper.createRemoteDirectory(foldersPath);
            console.log(tl.loc("FolderCreated", foldersPath));
        } catch (error) {
            await sshHelper.closeConnection();
            tl.setResult(tl.TaskResult.Failed, tl.loc('TargetNotCreated', foldersPath, error));
            return;
        }
    }

    console.log(tl.loc("FoldersCreated", folderStructure.length));

    const delayBetweenUploads = parseInt(tl.getInput('delayBetweenUploads'));

    // Upload files to remote machine
    const q = new Queue({
        concurrent: isNaN(concurrentUploads) ? 10 : concurrentUploads,
        delay: isNaN(delayBetweenUploads) ? 50 : delayBetweenUploads,
    });

    q.enqueue(preparedFiles.map((pathTuple) => {
        const [filepath, targetPath] = pathTuple;

        return {
            filepath,
            job: async () => {
                tl.debug(`Filepath = ${filepath}`);
                console.log(tl.loc('StartedFileCopy', filepath, targetPath));

                if (!overwrite && await sshHelper.checkRemotePathExists(targetPath)) {
                    throw new Error(tl.loc('FileExists', targetPath));
                }

                return await sshHelper.uploadFile(filepath, targetPath);
            }
        };
    }));

    const errors = [];
    let successfullyCopiedFilesCount = 0;

    q.on(QueueEvents.PROCESSED, () => successfullyCopiedFilesCount++);
    q.on(QueueEvents.EMPTY, () => tl.debug('Queue is empty'));
    q.on(QueueEvents.END, async () => {
        tl.debug('End of the queue processing');
        await sshHelper.closeConnection();

        if (errors.length === 0) {
            tl.setResult(tl.TaskResult.Succeeded, tl.loc('CopyCompleted', successfullyCopiedFilesCount));
        } else {
            tl.debug(`Errors count ${errors.length}`);
            errors.forEach((err) => tl.error(err));
            tl.setResult(tl.TaskResult.Failed, tl.loc('NumberFailed', errors.length));
        }
    });
    q.on(QueueEvents.ERROR, (error: unknown, filepath) => {
        if (error instanceof Error) {
            errors.push(tl.loc('FailedOnFile', filepath, error.message));
        }
        else {
            errors.push(tl.loc('FailedOnFile', filepath, error));
        }
    });
}

async function run() {
    let sshHelper: SshHelper;
    try {
        tl.setResourcePath(path.join(__dirname, 'task.json'));

        // read SSH endpoint input
        const sshEndpoint = tl.getInput('sshEndpoint', true);
        const username: string = tl.getEndpointAuthorizationParameter(sshEndpoint, 'username', false);
        const password: string = tl.getEndpointAuthorizationParameter(sshEndpoint, 'password', true); //passphrase is optional
        const privateKey: string = process.env['ENDPOINT_DATA_' + sshEndpoint + '_PRIVATEKEY']; //private key is optional, password can be used for connecting
        const hostname: string = tl.getEndpointDataParameter(sshEndpoint, 'host', false);
        let port: string = tl.getEndpointDataParameter(sshEndpoint, 'port', true); //port is optional, will use 22 as default port if not specified
        if (!port) {
            console.log(tl.loc('UseDefaultPort'));
            port = '22';
        }

        const readyTimeout = getReadyTimeoutVariable();
        const useFastPut: boolean = !(process.env['USE_FAST_PUT'] === 'false');

        // set up the SSH connection configuration based on endpoint details
        let sshConfig;
        if (privateKey) {
            tl.debug('Using private key for ssh connection.');
            sshConfig = {
                host: hostname,
                port: port,
                username: username,
                privateKey: privateKey,
                passphrase: password,
                readyTimeout: readyTimeout,
                useFastPut: useFastPut
            }
        } else {
            // use password
            tl.debug('Using username and password for ssh connection.');
            sshConfig = {
                host: hostname,
                port: port,
                username: username,
                password: password,
                readyTimeout: readyTimeout,
                useFastPut: useFastPut
            }
        }

        // contents is a multiline input containing glob patterns
        const contents: string[] = tl.getDelimitedInput('contents', '\n', true);
        const sourceFolder: string = tl.getPathInput('sourceFolder', true, true);
        let targetFolder: string = tl.getInput('targetFolder');

        if (!targetFolder) {
            targetFolder = "./";
        } else {
            // '~/' is unsupported
            targetFolder = targetFolder.replace(/^~\//, "./");
        }

        // read the copy options
        const cleanTargetFolder: boolean = tl.getBoolInput('cleanTargetFolder', false);
        const overwrite: boolean = tl.getBoolInput('overwrite', false);
        const failOnEmptySource: boolean = tl.getBoolInput('failOnEmptySource', false);
        const flattenFolders: boolean = tl.getBoolInput('flattenFolders', false);

        if (!tl.stats(sourceFolder).isDirectory()) {
            throw tl.loc('SourceNotFolder');
        }

        // initialize the SSH helpers, set up the connection
        sshHelper = new SshHelper(sshConfig);
        await sshHelper.setupConnection();

        if (cleanTargetFolder && await sshHelper.checkRemotePathExists(targetFolder)) {
            console.log(tl.loc('CleanTargetFolder', targetFolder));
            const isWindowsOnTarget: boolean = tl.getBoolInput('isWindowsOnTarget', false);
            const cleanHiddenFilesInTarget: boolean = tl.getBoolInput('cleanHiddenFilesInTarget', false);
            const cleanTargetFolderCmd: string = utils.getCleanTargetFolderCmd(targetFolder, isWindowsOnTarget, cleanHiddenFilesInTarget);
            try {
                await sshHelper.runCommandOnRemoteMachine(cleanTargetFolderCmd, null);
            } catch (err) {
                throw tl.loc('CleanTargetFolderFailed', err);
            }
        }

        // identify the files to copy
        const filesToCopy: string[] = getFilesToCopy(sourceFolder, contents);

        // copy files to remote machine
        if (filesToCopy) {
            tl.debug('Number of files to copy = ' + filesToCopy.length);
            tl.debug('filesToCopy = ' + filesToCopy);

            let failureCount = 0;
            console.log(tl.loc('CopyingFiles', filesToCopy.length));
            for (const fileToCopy of filesToCopy) {
                try {
                    tl.debug('fileToCopy = ' + fileToCopy);

                    let relativePath;
                    if (flattenFolders) {
                        relativePath = path.basename(fileToCopy);
                    } else {
                        relativePath = fileToCopy.substring(sourceFolder.length)
                            .replace(/^\\/g, "")
                            .replace(/^\//g, "");
                    }
                    tl.debug('relativePath = ' + relativePath);
                    let targetPath = path.posix.join(targetFolder, relativePath);

                    if (!path.isAbsolute(targetPath) && !utils.pathIsUNC(targetPath)) {
                        targetPath = `./${targetPath}`;
                    }

                    console.log(tl.loc('StartedFileCopy', fileToCopy, targetPath));
                    if (!overwrite) {
                        const fileExists: boolean = await sshHelper.checkRemotePathExists(targetPath);
                        if (fileExists) {
                            throw tl.loc('FileExists', targetPath);
                        }
                    }

                    targetPath = utils.unixyPath(targetPath);
                    // looks like scp can only handle one file at a time reliably
                    await sshHelper.uploadFile(fileToCopy, targetPath);
                } catch (err) {
                    tl.error(tl.loc('FailedOnFile', fileToCopy, err));
                    failureCount++;
                }
            }
            console.log(tl.loc('CopyCompleted', filesToCopy.length));
            if (failureCount) {
                tl.setResult(tl.TaskResult.Failed, tl.loc('NumberFailed', failureCount));
            }
        } else if (failOnEmptySource) {
            throw tl.loc('NothingToCopy');
        } else {
            tl.warning(tl.loc('NothingToCopy'));
        }
    } catch (err) {
        tl.setResult(tl.TaskResult.Failed, err);
    } finally {
        // close the client connection to halt build execution
        if (sshHelper) {
            tl.debug('Closing the client connection');
            await sshHelper.closeConnection();
        }
    }
}

if (tl.getBoolFeatureFlag('COPYFILESOVERSSHV0_USE_QUEUE')) {
    newRun();
} else {
    run().then(() => {
        tl.debug('Task successfully accomplished');
    })
        .catch(err => {
            tl.debug('Run was unexpectedly failed due to: ' + err);
        });
}

function getReadyTimeoutVariable(): number {
    let readyTimeoutString: string = tl.getInput('readyTimeout', true);
    const readyTimeout: number = parseInt(readyTimeoutString, 10);

    return readyTimeout;
}