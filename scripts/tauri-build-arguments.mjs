const DYNAMIC_CONFIG_ERROR =
  'Guarded Tauri packaging does not accept dynamic config overlays; add a reviewed platform config to src-tauri instead'
const ALTERNATE_RUNNER_ERROR =
  'Guarded Tauri packaging does not accept an alternate build runner'
const APPROVED_RUNNER_ARGUMENTS = ['--profile', 'fast-release']

const isDynamicConfigOption = (argument) =>
  argument === '--config' ||
  argument === '-c' ||
  argument.startsWith('--config=') ||
  (argument.startsWith('-c') && !argument.startsWith('--'))

export const getTauriCommandIndex = (args) => {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (isDynamicConfigOption(argument)) {
      throw new Error(DYNAMIC_CONFIG_ERROR)
    }
    if (
      argument === '--verbose' ||
      /^-[vVh]+$/u.test(argument) ||
      argument === '--help' ||
      argument === '--version'
    ) {
      continue
    }
    if (argument.startsWith('-')) {
      throw new Error('Unsupported Tauri global option')
    }
    return index
  }

  return -1
}

export const getTauriPackagingInputs = (commandArgs) => {
  let target
  let runnerArguments = []

  for (let index = 1; index < commandArgs.length; index += 1) {
    const argument = commandArgs[index]
    if (argument === '--') {
      runnerArguments = commandArgs.slice(index + 1)
      break
    }

    if (argument === '--config' || argument === '-c') {
      throw new Error(DYNAMIC_CONFIG_ERROR)
    }

    if (
      argument === '--runner' ||
      argument === '-r' ||
      argument.startsWith('--runner=') ||
      (argument.startsWith('-r') && !argument.startsWith('--'))
    ) {
      throw new Error(ALTERNATE_RUNNER_ERROR)
    }

    if (
      argument.startsWith('--config=') ||
      (argument.startsWith('-c') && !argument.startsWith('--'))
    ) {
      throw new Error(DYNAMIC_CONFIG_ERROR)
    }

    if (argument === '--target' || argument === '-t') {
      const value = commandArgs[index + 1]
      if (!value || value.startsWith('-')) {
        throw new Error(`${argument} requires a target value`)
      }
      target = value
      index += 1
      continue
    }

    if (argument.startsWith('--target=')) {
      const value = argument.slice('--target='.length)
      if (!value) throw new Error('--target requires a target value')
      target = value
      continue
    }

    if (argument.startsWith('-t') && !argument.startsWith('--')) {
      target = argument.slice(2)
      continue
    }

    if (/^-[^-]/u.test(argument)) {
      const shortOptions = argument.slice(1)
      if (shortOptions.includes('r')) {
        throw new Error(ALTERNATE_RUNNER_ERROR)
      }
      const firstValueOption = [...shortOptions].findIndex((option) =>
        ['r', 'f', 'b', 'c', 't'].includes(option),
      )
      if (firstValueOption > 0 && shortOptions[firstValueOption] === 'c') {
        throw new Error(DYNAMIC_CONFIG_ERROR)
      }
      if (firstValueOption > 0 && shortOptions[firstValueOption] === 't') {
        throw new Error(
          'Combined target syntax is not supported; pass it as a separate option',
        )
      }
    }
  }

  if (
    runnerArguments.length > 0 &&
    (runnerArguments.length !== APPROVED_RUNNER_ARGUMENTS.length ||
      runnerArguments.some(
        (argument, index) => argument !== APPROVED_RUNNER_ARGUMENTS[index],
      ))
  ) {
    throw new Error('Unsupported guarded build runner arguments')
  }

  return { target }
}

export const resolveTauriPlatform = (target, hostPlatform) => {
  if (target?.includes('windows')) return 'windows'
  if (target?.includes('darwin') || target?.includes('apple')) return 'macos'
  if (target?.includes('linux')) return 'linux'
  if (target) throw new Error('Unsupported Tauri desktop target')

  if (hostPlatform === 'win32') return 'windows'
  if (hostPlatform === 'darwin') return 'macos'
  if (hostPlatform === 'linux') return 'linux'

  throw new Error(`Unsupported Tauri desktop platform: ${hostPlatform}`)
}

export const getTauriPackagingPlan = (args, hostPlatform, environment = {}) => {
  const commandIndex = getTauriCommandIndex(args)
  if (commandIndex < 0) return undefined

  const command = args[commandIndex]
  if (command === 'bundle') {
    throw new Error(
      'Standalone Tauri bundle is disabled; use the guarded Tauri build command so packaged artifacts retain build provenance',
    )
  }
  if (command !== 'build') return undefined

  if (
    typeof environment.TAURI_CONFIG === 'string' &&
    environment.TAURI_CONFIG.trim() !== ''
  ) {
    throw new Error(
      'TAURI_CONFIG is not allowed for guarded Tauri packaging; use a reviewed platform config from src-tauri',
    )
  }

  const { target } = getTauriPackagingInputs(args.slice(commandIndex))
  return {
    command,
    commandIndex,
    platform: resolveTauriPlatform(target, hostPlatform),
    target,
  }
}
