import type { Layer } from "effect/Layer";
import { Api } from "./HttpApi.js";
/**
 * @since 1.0.0
 * @category model
 */
export type ScalarThemeId = "alternate" | "default" | "moon" | "purple" | "solarized" | "bluePlanet" | "deepSpace" | "saturn" | "kepler" | "mars" | "none";
/**
 * @since 1.0.0
 * @category model
 *
 * cdn: `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${source.version}/dist/browser/standalone.min.js`
 */
export type ScalarScriptSource = string | {
    type: "default";
} | {
    type: "cdn";
    version?: "latest" | (string & {});
};
/**
 * @since 1.0.0
 * @category model
 * @see https://github.com/scalar/scalar/blob/main/documentation/configuration.md
 */
export type ScalarConfig = {
    /** A string to use one of the color presets */
    theme?: ScalarThemeId;
    /** The layout to use for the references */
    layout?: "modern" | "classic";
    /** URL to a request proxy for the API client */
    proxy?: string;
    /** Whether the spec input should show */
    isEditable?: boolean;
    /** Whether to show the sidebar */
    showSidebar?: boolean;
    /**
     * Whether to show models in the sidebar, search, and content.
     *
     * @default false
     */
    hideModels?: boolean;
    /**
     * Whether to show the “Download OpenAPI Document” button
     *
     * @default false
     */
    hideDownloadButton?: boolean;
    /**
     * Whether to show the “Test Request” button
     *
     * @default: false
     */
    hideTestRequestButton?: boolean;
    /**
     * Whether to show the sidebar search bar
     *
     * @default: false
     */
    hideSearch?: boolean;
    /** Whether dark mode is on or off initially (light mode) */
    darkMode?: boolean;
    /** forceDarkModeState makes it always this state no matter what*/
    forceDarkModeState?: "dark" | "light";
    /** Whether to show the dark mode toggle */
    hideDarkModeToggle?: boolean;
    /**
     * Path to a favicon image
     *
     * @default undefined
     * @example '/favicon.svg'
     */
    favicon?: string;
    /** Custom CSS to be added to the page */
    customCss?: string;
    /**
     * The baseServerURL is used when the spec servers are relative paths and we are using SSR.
     * On the client we can grab the window.location.origin but on the server we need
     * to use this prop.
     *
     * @default undefined
     * @example 'http://localhost:3000'
     */
    baseServerURL?: string;
    /**
     * We’re using Inter and JetBrains Mono as the default fonts. If you want to use your own fonts, set this to false.
     *
     * @default true
     */
    withDefaultFonts?: boolean;
    /**
     * By default we only open the relevant tag based on the url, however if you want all the tags open by default then set this configuration option :)
     *
     * @default false
     */
    defaultOpenAllTags?: boolean;
};
/**
 * @since 1.0.0
 * @category layers
 */
export declare const layer: (options?: {
    readonly path?: `/${string}` | undefined;
    readonly source?: ScalarScriptSource;
    readonly scalar?: ScalarConfig;
}) => Layer<never, never, Api>;
//# sourceMappingURL=HttpApiScalar.d.ts.map