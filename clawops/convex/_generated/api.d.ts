/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as cards from "../cards.js";
import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as decisions from "../decisions.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as myFunctions from "../myFunctions.js";
import type * as projectMembers from "../projectMembers.js";
import type * as projectSetup from "../projectSetup.js";
import type * as projectors from "../projectors.js";
import type * as sweeper from "../sweeper.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  cards: typeof cards;
  commands: typeof commands;
  crons: typeof crons;
  decisions: typeof decisions;
  events: typeof events;
  http: typeof http;
  myFunctions: typeof myFunctions;
  projectMembers: typeof projectMembers;
  projectSetup: typeof projectSetup;
  projectors: typeof projectors;
  sweeper: typeof sweeper;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
