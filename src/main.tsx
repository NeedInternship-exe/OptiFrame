import { render } from 'preact';
import { registerSW } from 'virtual:pwa-register';
import { App } from './ui/App.tsx';
import './ui/capture.ts'; // starts loading the vision engine immediately
import './styles.css';

render(<App />, document.getElementById('app')!);
registerSW({ immediate: true });
