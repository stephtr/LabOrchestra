import { compile } from 'tailwindcss';
import theme from 'tailwindcss/theme.css'; import preflight from 'tailwindcss/preflight.css'; import util from 'tailwindcss/utilities.css';
globalThis.mk = () => compile(`@layer theme, base, components, utilities;@layer theme{${theme}}@layer base{${preflight}}@layer utilities{${util}}@theme{--color-brand:#0E4D3A}`);
