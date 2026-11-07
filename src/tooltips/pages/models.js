const modelsTooltips = {
  'Start connected services':
    'Start the connected engines Forge can manage. This does not load their models into GPU memory.',
  'MODEL FOLDER':
    'Shows the combined size of model files Forge manages in models/. Other engines may store files elsewhere.',
  'GPU memory':
    'Live GPU memory snapshot. Free memory can change when other apps load models or render work.',
  FREE: 'GPU memory available now. Forge checks this before loading supported models.',
  USED: 'GPU memory currently in use across the GPU.',
  TOTAL: 'Total GPU memory reported by the device.',
  'Clear after checking…':
    'Clear the queue barrier only after confirming the named model is not loading or waiting to load.',
  'Search models': 'Find models by name or category.',
  'Clear model search': 'Remove the search text and show models matching the selected category.',
  'Filter model category': 'Show all models or narrow the list to one category.',
  'FILE SIZE':
    'Measured size of the model files Forge manages. Links are excluded, so disk space recovered may differ.',
  'Stop service':
    'Stop this service normally. Forge only offers this when it can safely stop the service; memory may take a moment to be released.',
  'Force stop…':
    'Emergency stop for an unresponsive service. Active work may be interrupted; Forge must verify process ownership first.',
  'Force stop service':
    'Immediately stop the verified service process tree. Active work may be lost, and GPU memory may take a moment to return.',
  'Close force stop dialog': 'Close this dialog without stopping the service.',
  'Remove model': 'Review the model location and size before removing its files.',
  'Remove model files': 'Review storage details and confirm whether these files can be removed.',
  Location:
    'Where the model files are stored. Files outside Forge-managed storage must be managed in their original app.',
  'Measured file size':
    'Measured size of the installed model files. This may differ from the disk space recovered.',
  'Permanently delete model':
    'Permanently delete the managed model files. Project assets stay on disk; reinstall the model to use it again.',
  'Retry removal': 'Retry deleting the managed model files after a previous cleanup error.',
  'Not enough GPU memory':
    'The reported free GPU memory is below this model’s configured budget and reserve.',
  'FREE NOW': 'GPU memory currently available to load the requested model.',
  NEEDED: 'GPU memory budget and reserve configured for the requested model.',
  'SHORT BY': 'Estimated amount of additional free GPU memory needed before loading can proceed.',
  'Models and services using memory':
    'Services that may be using GPU memory. Forge can stop an idle service it started; external services must be stopped in their own app.',
  'Stop selected service & retry':
    'Stop the selected idle service, then check GPU memory and retry the model load.',
  'Retry memory check': 'Check current GPU memory again and retry loading the model.',
  'Close memory dialog': 'Close this notice without changing any running service.',
  'Hugging Face read token':
    'Optional if access is already configured. Used by the local Stable Audio worker to access the gated model.',
  'Check memory & load': 'Check available GPU memory and request that Stable Audio load.',
};

export default modelsTooltips;
