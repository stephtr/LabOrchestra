import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as sdk from './widget-sdk';

/** The modules that runtime widgets import (react, the SDK): the host's own instances, found by the shims in public/_lo (see gen-shims.mjs). */
(globalThis as any).__lo = {
	react: React,
	'react/jsx-runtime': jsxRuntime,
	'react-dom': ReactDOM,
	'react-dom/client': ReactDOMClient,
	'@laborchestra/widget': sdk,
};
