// Installs the config-loader hook. Used as `node --import ./tests/helpers/register.mjs`.
import { register } from "node:module";
register("./config-loader.mjs", import.meta.url);
