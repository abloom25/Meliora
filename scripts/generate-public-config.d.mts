export interface GeneratePublicConfigOptions {
  configPath?: string
  targetPath?: string
  adminEnvTargetPath?: string
  encryptionKey?: string
  adminEnv?: Record<string, string | undefined>
}

export interface GeneratePublicConfigResult {
  config: Record<string, unknown>
  targetPath: string
  adminEnvTargetPath: string
}

export function encryptStoredConfig(plaintext: string, encryptionKey: string): Promise<string>

export function decryptStoredConfig(stored: string, encryptionKey: string): Promise<string>

export function generatePublicConfig(
  options?: GeneratePublicConfigOptions,
): Promise<GeneratePublicConfigResult>
