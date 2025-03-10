/// <reference path="../global.d.ts" />
import {log, warn, error} from '../util/log';
import {
    StandardScratchExtensionClass as ExtensionClass,
    ExtensionMetadata,
    ExtensionMenu,
    ExtensionBlockMetadata,
    BlockType,
    MenuItems,
    BlockArgs
} from '../typings';
import {
    maybeFormatMessage
} from '../util/maybe-format-message';
import { CentralDispatch as dispatch } from './dispatch/central-dispatch';
import { makeCtx } from './make-ctx';
import ExtensionSandbox from './sandbox.worker';
import type VM from 'scratch-vm';

interface PendingExtensionWorker {
    extensionURL: string,
    resolve: (value: unknown) => void;
    reject: (value: unknown) => void;
}

export interface ScratchExtension {
    id: string;
    url: string;
    env: 'sandboxed' | 'unsandboxed';
    info: ExtensionMetadata;
    instance: string | ExtensionClass; // The serviceName or extensionClass.
}

class ChibiLoader {
    /**
     * Editor's Virtual Machine instance.
     * Should be set by `attachVM` while initializing.
     * @todo add more strict type check when VM adds TS support.
     */
    vm: VM;

    /**
     * The ID number to provide to the next extension worker.
     * @type {int}
     */
    private nextExtensionWorker = 0;
    
    /**
     * Whether Scratch object should be passed inline.
     * @type {boolean}
     */
    private inlinedCtx = false;

    /**
     * FIFO queue of extensions which have been requested but not yet loaded in a worker,
     * along with promise resolution functions to call once the worker is ready or failed.
     *
     * @type {Array.<PendingExtensionWorker>}
     */
    private pendingExtensions: PendingExtensionWorker[] = [];

    /**
     * Map of worker ID to workers which have been allocated but have not yet finished initialization.
     * @type {Array.<PendingExtensionWorker>}
     */
    private pendingWorkers: PendingExtensionWorker[] = [];

    /**
     * Loaded scratch extensions, ID with extension info.
     * @type {Map<string, ExtensionClass>}
     */
    loadedScratchExtension = new Map<string, ScratchExtension>();

    constructor (vm: VM) {
        this.vm = vm;
        this.inlinedCtx = typeof window.Scratch === 'object';
        if (!this.inlinedCtx) {
            window.Scratch = makeCtx(this.vm);
        } else {
            warn('A Scratch instance already exists in the current environment, so it will be passed inline for unsandboxed extension.');
        }
        dispatch.setService('loader', this).catch((e: Error) => {
            error(`ChibiLoader was unable to register extension service: ${JSON.stringify(e)}`);
        });
    }

    /**
     * Load a scratch-standard extension.
     * @param {ExtensionClass | string} ext - Extension's data.
     * @param {'sandboxed' | 'unsandboxed'} env - Extension's running environment.
     */
    async load (ext: string | ExtensionClass, env: 'sandboxed' | 'unsandboxed' = 'sandboxed') {
        if (typeof ext === 'string') {
            switch (env) {
            case 'sandboxed':
                return new Promise((resolve, reject) => {
                    // If we `require` this at the global level it breaks non-webpack targets, including tests
                    const ExtensionWorker = new ExtensionSandbox();
                    this.pendingExtensions.push({
                        extensionURL: ext,
                        resolve,
                        reject
                    });
                    dispatch.addWorker(ExtensionWorker);
                });
            case 'unsandboxed': {
                const response = await fetch(ext);
                const originalScript = await response.text();
                const closureFunc = new Function('Scratch', originalScript);
                const ctx = makeCtx(this.vm);
                ctx.extensions.register = (extensionObj: ExtensionClass) => {
                    const extensionInfo = extensionObj.getInfo();
                    this._registerExtensionInfo(extensionObj, extensionInfo, ext);
                };
                closureFunc(ctx);
                return;
            }
            default:
                throw new Error('unexpected env');
            }
        }

        // @ts-expect-error Load as builtin extension.
        const extensionObject = new ext(this.vm.runtime);
        const extensionInfo = extensionObject.getInfo() as ExtensionMetadata;
        this._registerExtensionInfo(extensionObject, extensionInfo, extensionInfo.id);
        return extensionInfo;
    }

    /**
     * Reload a scratch-standard extension.
     * @param {string} extensionId - Extension's ID
     */
    async reload (extensionId: string) {
        const targetExt = this.loadedScratchExtension.get(extensionId);
        if (!targetExt) {
            throw new Error(`Cannot locate extension ${extensionId}.`);
        }
        // It's running in worker
        if (typeof targetExt.instance === 'string') {
            const info = await dispatch.call(targetExt.instance, 'getInfo');
            const processedInfo = this._prepareExtensionInfo(null, info, targetExt.instance);
            // @ts-expect-error private method
            this.vm.runtime._refreshExtensionPrimitives(processedInfo);
            return processedInfo;
        }
        let info = targetExt.instance.getInfo();
        info = this._prepareExtensionInfo(targetExt.instance, info);
        // @ts-expect-error private method
        this.vm.runtime._refreshExtensionPrimitives(info);
        return info;
    }

    /**
     * Get all sideloaded extension infos.
     */
    getLoadedInfo () {
        const extensionURLs: Record<string, string> = {};
        const extensionEnv: Record<string, string> = {};
        for (const [extId, ext] of this.loadedScratchExtension.entries()) {
            extensionURLs[extId] = ext.url;
            extensionEnv[extId] = ext.env;
        }
        return [extensionURLs, extensionEnv];
    }

    getIdByUrl (url: string) {
        for (const [extId, ext] of this.loadedScratchExtension.entries()) {
            if (ext.url === url) {
                return extId;
            }
        }
    }

    /**
     * Reload all scratch-standard extensions.
     * This method is only a replacement of refreshBlocks in
     *  original extension manager to reload locales. It should
     * be replaced when there's a better solution.
     */
    reloadAll () {
        const allPromises: Promise<ExtensionMetadata | void>[] = [];
        for (const [extId] of this.loadedScratchExtension.entries()) {
            allPromises.push(this.reload(extId));
        }
        return Promise.all(allPromises);
    }

    /**
     * Sanitize extension info then register its primitives with the VM.
     * @param {ExtensionClass | null} extensionObject - the extension object providing the menu.
     * @param {ExtensionInfo} extensionInfo - the extension's metadata
     * @param {string} serviceName - the name of the service hosting the extension
     * @private
     */
    private _registerExtensionInfo (extensionObject: ExtensionClass | null, extensionInfo: ExtensionMetadata, extensionURL: string, serviceName?: string) {
        if (!this.loadedScratchExtension.has(extensionInfo.id)) {
            if (!extensionObject && !serviceName) {
                throw new Error(`Cannnot mark ${extensionInfo.id} as loaded.`);
            }

            this.loadedScratchExtension.set(extensionInfo.id, {
                type: 'scratch',
                id: extensionInfo.id,
                url: extensionURL,
                info: extensionInfo,
                instance: (extensionObject ?? serviceName) as ExtensionClass | string,
                env: serviceName ? 'sandboxed' : 'unsandboxed'
            } as ScratchExtension);
        }
        extensionInfo = this._prepareExtensionInfo(extensionObject, extensionInfo, serviceName);

        // @ts-expect-error private method
        this.vm.runtime._registerExtensionPrimitives(extensionInfo);
    }

    /**
     * Modify the provided text as necessary to ensure that it may be used as an attribute value in valid XML.
     * @param {string} text - the text to be sanitized
     * @returns {string} - the sanitized text
     * @private
     */
    private _sanitizeID (text: string) {
        return text.toString().replace(/[<"&]/, '_');
    }

    /**
     * Apply minor cleanup and defaults for optional extension fields.
     * TODO: make the ID unique in cases where two copies of the same extension are loaded.
     * @param {ExtensionClass | null} extensionObject - the extension object providing the menu.
     * @param {ExtensionInfo} extensionInfo - the extension info to be sanitized
     * @param {string} serviceName - the name of the service hosting this extension block
     * @returns {ExtensionInfo} - a new extension info object with cleaned-up values
     * @private
     */
    private _prepareExtensionInfo (extensionObject: ExtensionClass | null, extensionInfo: ExtensionMetadata, serviceName?: string) {
        extensionInfo = Object.assign({}, extensionInfo);
        if (!/^[a-z0-9]+$/i.test(extensionInfo.id)) {
            throw new Error('Invalid extension id');
        }
        extensionInfo.name = extensionInfo.name || extensionInfo.id;
        extensionInfo.blocks = extensionInfo.blocks || [];
        extensionInfo.targetTypes = extensionInfo.targetTypes || [];
        extensionInfo.blocks = extensionInfo.blocks.reduce((results: Array<string | ExtensionBlockMetadata>, blockInfo) => {
            try {
                let result;
                switch (blockInfo) {
                case '---': // Separator
                    result = '---';
                    break;
                default: // An ExtensionBlockMetadata object
                    result = this._prepareBlockInfo(extensionObject, blockInfo as ExtensionBlockMetadata, serviceName);
                    break;
                }
                results.push(result);
            } catch (e: unknown) {
                // TODO: more meaningful error reporting
                error(`Error processing block: ${(e as Error).message}, Block:\n${JSON.stringify(blockInfo)}`);
            }
            return results;
        }, []);
        extensionInfo.menus = extensionInfo.menus || {};
        extensionInfo.menus = this._prepareMenuInfo(extensionObject, extensionInfo.menus, serviceName);
        return extensionInfo as ExtensionMetadata;
    }

    /**
     * Prepare extension menus. e.g. setup binding for dynamic menu functions.
     * @param {ExtensionClass} extensionObject - the extension object providing the menu.
     * @param {Array.<MenuInfo>} menus - the menu defined by the extension.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @returns {Array.<MenuInfo>} - a menuInfo object with all preprocessing done.
     * @private
     */
    private _prepareMenuInfo (extensionObject: ExtensionClass | null, menus: Record<string, ExtensionMenu>, serviceName?: string) {
        const menuNames = Object.getOwnPropertyNames(menus);
        for (let i = 0; i < menuNames.length; i++) {
            const menuName = menuNames[i];
            let menuInfo = menus[menuName];

            /*
             * If the menu description is in short form (items only) then normalize it to general form: an object with
             * its items listed in an `items` property.
             */
            if (!menuInfo.items) {
                menuInfo = {
                    // @ts-expect-error
                    items: menuInfo
                };
                menus[menuName] = menuInfo;
            }
            /*
             * If `items` is a string, it should be the name of a function in the extension object. Calling the
             * function should return an array of items to populate the menu when it is opened.
             */
            if (typeof menuInfo.items === 'string') {
                const menuItemFunctionName = menuInfo.items;
                // @ts-expect-error Bind the function here so we can pass a simple item generation function to Scratch Blocks later
                menuInfo.items = this._getExtensionMenuItems.bind(this, extensionObject, menuItemFunctionName, serviceName);
            }
        }
        return menus;
    }

    /**
     * Fetch the items for a particular extension menu, providing the target ID for context.
     * @param {ExtensionClass} extensionObject - the extension object providing the menu.
     * @param {string} menuItemFunctionName - the name of the menu function to call.
     * @param {string} serviceName - the name of the service hosting this extension block
     * @returns {Array} menu items ready for scratch-blocks.
     * @private
     */
    private _getExtensionMenuItems (extensionObject: ExtensionClass, menuItemFunctionName: string, serviceName?: string): any[] {
        /*
         * Fetch the items appropriate for the target currently being edited. This assumes that menus only
         * collect items when opened by the user while editing a particular target.
         */

        const editingTarget = this.vm.runtime.getEditingTarget() || this.vm.runtime.getTargetForStage();
        const editingTargetID = editingTarget ? editingTarget.id : null;
        // @ts-expect-error private method
        const extensionMessageContext = this.vm.runtime.makeMessageContextForTarget(editingTarget);

        // TODO: Fix this to use dispatch.call when extensions are running in workers.
        const menuFunc = extensionObject[menuItemFunctionName] as (editingTargetID: string | null) => MenuItems;
        const menuItems = menuFunc.call(extensionObject, editingTargetID).map(
            item => {
                item = maybeFormatMessage(item, extensionMessageContext);
                switch (typeof item) {
                case 'object':
                    return [
                        maybeFormatMessage(item.text, extensionMessageContext),
                        item.value
                    ];
                case 'string':
                    return [item, item];
                default:
                    return item;
                }
            });

        if (!menuItems || menuItems.length < 1) {
            throw new Error(`Extension menu returned no items: ${menuItemFunctionName}`);
        }
        return menuItems;
    }

    /**
     * Apply defaults for optional block fields.
     * @param {ExtensionClass} extensionObject - the extension object providing the menu.
     * @param {ExtensionBlockMetadata} blockInfo - the block info from the extension
     * @param {string} serviceName - the name of the service hosting this extension block
     * @returns {ExtensionBlockMetadata} - a new block info object which has values for all relevant optional fields.
     * @private
     */
    private _prepareBlockInfo (extensionObject: ExtensionClass | null, blockInfo: ExtensionBlockMetadata, serviceName?: string) {
        blockInfo = Object.assign({}, {
            blockType: BlockType.COMMAND,
            terminal: false,
            blockAllThreads: false,
            arguments: {}
        }, blockInfo);
        blockInfo.opcode = blockInfo.opcode && this._sanitizeID(blockInfo.opcode);
        blockInfo.text = blockInfo.text || blockInfo.opcode;

        switch (blockInfo.blockType) {
        case BlockType.EVENT:
            if (blockInfo.func) {
                warn(`Ignoring function "${blockInfo.func}" for event block ${blockInfo.opcode}`);
            }
            break;
        case BlockType.BUTTON:
            if (blockInfo.opcode) {
                warn(`Ignoring opcode "${blockInfo.opcode}" for button with text: ${blockInfo.text}`);
            }
            break;
        default: {
            if (!blockInfo.opcode) {
                throw new Error('Missing opcode for block');
            }

            const funcName = blockInfo.func ? this._sanitizeID(blockInfo.func) : blockInfo.opcode;
             
            const getBlockInfo = blockInfo.isDynamic ?
                (args: BlockArgs) => args && args.mutation && args.mutation.blockInfo :
                () => blockInfo;
            const callBlockFunc = (() => {
                // Maybe there's a worker
                if (extensionObject === null) {
                    if (serviceName && dispatch._isRemoteService(serviceName)) {
                        return (args: BlockArgs, _util: unknown, realBlockInfo: unknown) =>
                            dispatch.call(serviceName, funcName, args, undefined, realBlockInfo);
                    } 
                    warn(`Could not find extension block function called ${funcName}`);
                    // eslint-disable-next-line @typescript-eslint/no-empty-function
                    return () => {};
                }
             
                if (!extensionObject[funcName]) {
                    // The function might show up later as a dynamic property of the service object
                    warn(`Could not find extension block function called ${funcName}`);
                }
                return (args: BlockArgs, util: unknown, realBlockInfo: unknown) =>
                    // @ts-expect-error
                    extensionObject[funcName](args, util, realBlockInfo);
            })();

            // @ts-expect-error
            blockInfo.func = (args: BlockArgs, util: unknown) => {
                const realBlockInfo = getBlockInfo(args);
                // TODO: filter args using the keys of realBlockInfo.arguments? maybe only if sandboxed?
                return callBlockFunc(args, util, realBlockInfo);
            };
            break;
        }
        }

        return blockInfo;
    }

    async updateLocales () {
        await this.reloadAll();
    }

    /**
     * Regenerate blockinfo for any loaded extensions
     * @returns {Promise} resolved once all the extensions have been reinitialized
     */
    async refreshBlocks () {
        await this.reloadAll();
    }

    allocateWorker () {
        const workerInfo = this.pendingExtensions.shift();
        if (!workerInfo) {
            warn('pending extension queue is empty');
            return;
        }
        const id = this.nextExtensionWorker++;
        this.pendingWorkers[id] = workerInfo;
        return [id, workerInfo.extensionURL];
    }

    /**
     * Collect extension metadata from the specified service and begin the extension registration process.
     * @param {string} serviceName - the name of the service hosting the extension.
     */
    async registerExtensionService (extensionURL: string, serviceName: string) {
        const info = await dispatch.call(serviceName, 'getInfo');
        this._registerExtensionInfo(null, info, extensionURL, serviceName);
    }

    /**
     * Called by an extension worker to indicate that the worker has finished initialization.
     * @param {int} id - the worker ID.
     * @param {*?} e - the error encountered during initialization, if any.
     */
    onWorkerInit (id: number, e?: Error) {
        const workerInfo = this.pendingWorkers[id];
        delete this.pendingWorkers[id];
        if (e) {
            workerInfo.reject(e);
        } else {
            workerInfo.resolve(id);
        }
    }
}

export {
    ChibiLoader
};
