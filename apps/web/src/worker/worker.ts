import * as Comlink from 'comlink';
import { Engine } from './engine.ts';

Comlink.expose(new Engine());
