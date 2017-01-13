import * as _ from 'lodash';

import { registerMode, deregisterMode, ModeMetadata } from './modes';
import logger, { Logger } from './logger';
import * as errors from './errors';
import EventEmitter, { Listener, Hook } from './eventEmitter';
import Document from './document';
import Cursor from './cursor';
import Session from './session';
import defaultKeyMappings, { HotkeyMapping } from './keyMappings';
import { KeyBindings } from './keyBindings';
import { Row, ModeId } from './types';
import {
  KeyDefinitions, Action, Motion,
  ActionDefinition, MotionDefinition, ActionMetadata
} from './keyDefinitions';

type PluginMetadata = {
  name: string;
  version?: number;
  author?: string;
  description?: string;
};

type PluginEnableFn<V> = (api: PluginApi) => Promise<V> | V;
type PluginDisableFn<V> =  (api: PluginApi, value: V) => Promise<void> | void;
type RegisteredPlugin<V> = {
  name: string;
  version?: number;
  author?: string;
  description?: string;
  enable: PluginEnableFn<V>;
  disable: PluginDisableFn<V>;
};

// global set of registered plugins
const PLUGINS: {[pluginName: string]: RegisteredPlugin<any>} = {};

export enum PluginStatus {
  UNREGISTERED = 0,
  DISABLING = 1,
  DISABLED = 2,
  ENABLING = 3,
  ENABLED = 4,
};

type Emitter = 'document' | 'session';

// class for exposing plugin API
export class PluginApi {
  public session: Session;
  private metadata: PluginMetadata;
  private pluginManager: PluginsManager;
  private name: string;
  private document: Document;
  public cursor: Cursor;
  public logger: Logger;
  private bindings: KeyBindings;
  private definitions: KeyDefinitions;

  private registrations: Array<() => void>;

  constructor(session: Session, metadata: PluginMetadata, pluginManager: PluginsManager) {
    this.session = session;
    this.metadata = metadata;
    this.pluginManager = pluginManager;
    this.name = this.metadata.name;
    this.document = this.session.document;
    this.cursor = this.session.cursor;
    // TODO: Add subloggers and prefix all log messages with the plugin name
    this.logger = logger;

    this.bindings = this.session.bindings;
    this.definitions = this.bindings.definitions;

    this.registrations = [];
  }

  public async setData(key: string, value: any) {
    return await this.document.store.setPluginData(this.name, key, value);
  }

  public async getData(key: string, default_value: any = null) {
    return await this.document.store.getPluginData(this.name, key, default_value);
  }

  // marks row for re-rendering
  public async updatedDataForRender(row: Row) {
    // this is sort of a weird implementation,
    // but it causes the cachedRowInfo to get updated
    // and also updates pluginData, which is the typical use case
    await this.document.updateCachedPluginData(row);
  }

  public registerMode(metadata: ModeMetadata) {
    const mode = registerMode(metadata);
    this.registrations.push(() => {
      this.deregisterMode(metadata);
    });
    return mode;
  }

  public deregisterMode(metadata: ModeMetadata) {
    deregisterMode(metadata);
  }

  public registerDefaultMappings(mode: ModeId, mappings: HotkeyMapping) {
    defaultKeyMappings.registerModeMappings(mode, mappings);
    this.registrations.push(() => {
      this.deregisterDefaultMappings(mode, mappings);
    });
  }

  public deregisterDefaultMappings(mode: ModeId, mappings: HotkeyMapping) {
    defaultKeyMappings.deregisterModeMappings(mode, mappings);
  }

  public registerMotion(name: string, desc: string, def: MotionDefinition) {
    const motion = new Motion(name, desc, def);
    this.definitions.registerMotion(motion);
    this.registrations.push(() => {
      this.deregisterMotion(motion.name);
    });
    return motion;
  }

  public deregisterMotion(name: string) {
    this.definitions.deregisterMotion(name);
  }

  public registerAction(name: string, desc: string, def: ActionDefinition, metadata: ActionMetadata = {}) {
    const action = new Action(name, desc, def, metadata);
    this.definitions.registerAction(action);
    this.registrations.push(() => {
      this.deregisterAction(action.name);
    });
    return action;
  }

  public deregisterAction(name: string) {
    this.definitions.deregisterAction(name);
  }

  private _getEmitter(who: Emitter): Document | Session {
    if (who === 'document') {
      return this.document;
    } else if (who === 'session') {
      return this.session;
    } else {
      throw new errors.GenericError `Unknown hook listener ${who}`;
    }
  }

  public registerListener(who: Emitter, event: string, listener: Listener) {
    const emitter = this._getEmitter(who);
    emitter.on(event, listener);
    this.registrations.push(() => {
      this.deregisterListener(who, event, listener);
    });
  }

  public deregisterListener(who: Emitter, event: string, listener: Listener) {
    const emitter = this._getEmitter(who);
    emitter.off(event, listener);
  }

  // TODO: type this better
  public registerHook(who: Emitter, event: string, transform: Hook) {
    const emitter = this._getEmitter(who);
    emitter.addHook(event, transform);
    this.registrations.push(() => {
      this.deregisterHook(who, event, transform);
    });
    // pluginData can change for all rows (also could be render-related hook)
    this.document.cache.clear();
  }

  public deregisterHook(who: Emitter, event: string, transform: Hook) {
    const emitter = this._getEmitter(who);
    emitter.removeHook(event, transform);
    // pluginData can change for all rows (also could be render-related hook)
    this.document.cache.clear();
  }

  public deregisterAll() {
    this.registrations.reverse().forEach((deregisterFn) => {
      deregisterFn();
    });
    this.registrations = [];
  }

  public async panic() {
    // await this.pluginManager.disable(this.name);
    throw new Error(
      `Plugin '${this.name}' has encountered a major problem.
      Please report this problem to the plugin author.`
    );
  }
}

export class PluginsManager extends EventEmitter {
  private session: Session;
  private plugin_infos: {
    [key: string]: {
      api?: PluginApi,
      value?: any,
      status?: PluginStatus,
    }
  };

  constructor(session: Session) {
    super();
    this.session = session;
    this.plugin_infos = {};
  }

  public getInfo(name: string) {
    return this.plugin_infos[name];
  }

  public getStatus(name: string): PluginStatus {
    if (!PLUGINS[name]) {
      return PluginStatus.UNREGISTERED;
    }
    return (this.plugin_infos[name] && this.plugin_infos[name].status) || PluginStatus.DISABLED;
  }

  public setStatus(name: string, status: PluginStatus) {
    logger.debug(`Plugin ${name} status: ${status}`);
    if (!PLUGINS[name]) {
      throw new Error(`Plugin ${name} was not registered`);
    }
    const plugin_info = this.plugin_infos[name] || {};
    plugin_info.status = status;
    this.plugin_infos[name] = plugin_info;
    this.emit('status');
  }

  public updateEnabledPlugins() {
    const enabled: Array<string> = [];
    for (const name in this.plugin_infos) {
      if ((this.getStatus(name)) === PluginStatus.ENABLED) {
        enabled.push(name);
      }
    }
    this.emit('enabledPluginsChange', enabled);
  }

  public async enable(name: string) {
    const status = this.getStatus(name);
    if (status === PluginStatus.UNREGISTERED) {
      logger.error(`No plugin registered as ${name}`);
      return;
    }
    if (status === PluginStatus.ENABLING) {
      throw new errors.GenericError(`Already enabling plugin ${name}`);
    }
    if (status === PluginStatus.DISABLING) {
      throw new errors.GenericError(`Still disabling plugin ${name}`);
    }
    if (status === PluginStatus.ENABLED) {
      throw new errors.GenericError(`Plugin ${name} is already enabled`);
    }

    errors.assert(status === PluginStatus.DISABLED);
    this.setStatus(name, PluginStatus.ENABLING);

    const plugin = PLUGINS[name];
    const api = new PluginApi(this.session, plugin, this);
    const value = await plugin.enable(api);

    this.plugin_infos[name] = { api, value };
    this.setStatus(name, PluginStatus.ENABLED);
    this.updateEnabledPlugins();
  }

  public async disable(name: string) {
    const status = this.getStatus(name);
    if (status === PluginStatus.UNREGISTERED) {
      throw new errors.GenericError(`No plugin registered as ${name}`);
    }
    if (status === PluginStatus.ENABLING) {
      throw new errors.GenericError(`Still enabling plugin ${name}`);
    }
    if (status === PluginStatus.DISABLING) {
      throw new errors.GenericError(`Already disabling plugin ${name}`);
    }
    if (status === PluginStatus.DISABLED) {
      throw new errors.GenericError(`Plugin ${name} already disabled`);
    }

    // TODO: require that no other plugin has this as a dependency, notify user otherwise
    errors.assert(status === PluginStatus.ENABLED);
    this.setStatus(name, PluginStatus.DISABLING);

    const plugin_info = this.plugin_infos[name];
    if (!plugin_info) {
      throw new Error(`Enabled plugin ${name} missing from info?`);
    }
    if (!plugin_info.api) {
      throw new Error(`Enabled plugin ${name} missing api?`);
    }
    const plugin = PLUGINS[name];
    if (!plugin) {
      throw new Error(`Enabled plugin ${name} missing from registration?`);
    }
    await plugin.disable(plugin_info.api, plugin_info.value);
    delete this.plugin_infos[name];
    this.updateEnabledPlugins();
  }
}

export const registerPlugin = function<V>(
  plugin_metadata: PluginMetadata,
  enable: PluginEnableFn<V>,
  disable: PluginDisableFn<V>,
) {
  plugin_metadata.version = plugin_metadata.version || 1;
  plugin_metadata.author = plugin_metadata.author || 'anonymous';

  // Create the plugin object
  // Plugin stores all data about a plugin, including metadata
  // plugin.value contains the actual resolved value
  const plugin: RegisteredPlugin<V> = {
    ..._.cloneDeep(plugin_metadata),
    enable,
    disable: disable || _.once(function(api: PluginApi) {
      api.deregisterAll();
      throw new Error(
        `The plugin '${plugin.name}' was disabled but doesn't support online disable functionality. Refresh to disable.`
      );
    }),
  };
  PLUGINS[plugin.name] = plugin;
};

// exports
export function all() { return PLUGINS; }
export function getPlugin(name: string) { return PLUGINS[name]; }
export function names() { return (_.keys(PLUGINS)).sort(); }
