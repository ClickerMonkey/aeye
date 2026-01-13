import { AWSBedrockProvider } from '@aeye/aws';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import React, { useState, useEffect } from 'react';
import { ConfigFile } from '../config';
import { KnowledgeFile } from '../knowledge';
import type { Providers } from '../schemas';

type WizardStep =
  | 'openai-env'
  | 'openai-confirm'
  | 'openai-input'
  | 'openrouter-env'
  | 'openrouter-confirm'
  | 'openrouter-input'
  | 'replicate-env'
  | 'replicate-confirm'
  | 'replicate-input'
  | 'aws-test'
  | 'aws-configure'
  | 'aws-confirm'
  | 'custom-confirm'
  | 'custom-name'
  | 'custom-base-url'
  | 'custom-api-key'
  | 'tavily-env'
  | 'tavily-confirm'
  | 'tavily-input'
  | 'user-name'
  | 'user-pronouns'
  | 'user-memory'
  | 'complete';

interface InkInitWizardProps {
  onComplete: (config: ConfigFile) => void;
}

export const InkInitWizard: React.FC<InkInitWizardProps> = ({ onComplete }) => {
  const [step, setStep] = useState<WizardStep>('openai-env');
  const [providers, setProviders] = useState<Providers>({
    openai: null,
    openrouter: null,
    replicate: null,
    aws: null,
    custom: null,
  });
  const [tavilyConfig, setTavilyConfig] = useState<{ apiKey: string } | null>(null);
  const [name, setName] = useState('');
  const [pronouns, setPronouns] = useState('');
  const [memory, setMemory] = useState('');

  // Input states for all steps (moved to top level to avoid hooks violations)
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  
  // Custom provider states
  const [customName, setCustomName] = useState('');
  const [customBaseUrl, setCustomBaseUrl] = useState('');

  // AWS test state
  const [awsTestStatus, setAwsTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [awsTestMessage, setAwsTestMessage] = useState<string>('');

  // Set terminal title
  useEffect(() => {
    process.stdout.write('\x1b]0;Cletus: Setup\x07');
    return () => {
      process.stdout.write('\x1b]0;Cletus\x07');
    };
  }, []);

  // Check environment variables
  const openaiKey = process.env.OPENAI_API_KEY;
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const replicateKey = process.env.REPLICATE_API_KEY;
  const awsRegion = process.env.AWS_REGION;
  const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const tavilyKey = process.env.TAVILY_API_KEY;

  // Reset input states when step changes
  React.useEffect(() => {
    setApiKey('');
    setError(null);
  }, [step]);
  
  // Initialize AWS test on first render
  React.useEffect(() => {
    if (step === 'aws-test' && awsTestStatus === 'idle') {
      testAWSCredentials();
    }
  }, [step]);


  // Test AWS credentials
  const testAWSCredentials = async (): Promise<boolean> => {
    setAwsTestStatus('testing');
    setAwsTestMessage('Testing AWS credentials...');

    try {
      const awsProvider = new AWSBedrockProvider({
        region: process.env.AWS_REGION || 'us-east-1',
      });

      const isHealthy = await awsProvider.checkHealth();

      if (isHealthy) {
        setAwsTestStatus('success');
        setAwsTestMessage('✓ AWS credentials detected and working!');
        return true;
      } else {
        setAwsTestStatus('error');
        setAwsTestMessage('⚠️ AWS credentials test failed.');
        return false;
      }
    } catch (error: any) {
      setAwsTestStatus('error');
      if (error.name === 'CredentialsProviderError' || error.name === 'UnrecognizedClientException') {
        setAwsTestMessage('⚠️ No AWS credentials found. Please configure manually.');
      } else if (error.name === 'AccessDeniedException') {
        setAwsTestMessage('✓ AWS credentials found but no Bedrock access. Check IAM permissions.');
      } else {
        setAwsTestMessage(`⚠️ AWS test failed: ${error.message || 'Unknown error'}`);
      }
      return false;
    }
  };

  // Handle Ctrl+C to exit wizard at any step
  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      if (step === 'complete') {
        // Already complete, do nothing
        return;
      }
      // Exit the setup process
      process.exit(0);
    }
  });

  // OpenAI - Environment Key Detected
  if (step === 'openai-env' && openaiKey) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Welcome to Cletus! Let's get you set up.
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>OpenAI API key detected in environment. Use it?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setProviders({ ...providers, openai: { apiKey: openaiKey } });
            }
            setStep(openrouterKey ? 'openrouter-env' : 'openrouter-confirm');
          }}
        />
      </Box>
    );
  }

  // OpenAI - Ask to Configure
  if (step === 'openai-env' && !openaiKey) {
    setStep('openai-confirm');
  }

  if (step === 'openai-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Welcome to Cletus! Let's get you set up.
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text>Would you like to configure OpenAI?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setStep('openai-input');
            } else {
              setStep(openrouterKey ? 'openrouter-env' : 'openrouter-confirm');
            }
          }}
        />
      </Box>
    );
  }

  // OpenAI - Input API Key
  if (step === 'openai-input') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            OpenAI Setup
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Get your API key from: https://platform.openai.com/api-keys</Text>
          <Text dimColor>Note: You'll need to create an account and add credits to use OpenAI.</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setError(null);
            }}
            placeholder="sk-..."
            onSubmit={() => {
              if (!apiKey) {
                setError('API key is required');
                return;
              }
              if (!apiKey.startsWith('sk-')) {
                setError('OpenAI API keys start with sk-');
                return;
              }
              setProviders({ ...providers, openai: { apiKey } });
              setStep(openrouterKey ? 'openrouter-env' : 'openrouter-confirm');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // OpenRouter - Environment Key Detected
  if (step === 'openrouter-env' && openrouterKey) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>OpenRouter API key detected in environment. Use it?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setProviders({ ...providers, openrouter: { apiKey: openrouterKey } });
            }
            setStep(replicateKey ? 'replicate-env' : 'replicate-confirm');
          }}
        />
      </Box>
    );
  }

  // OpenRouter - Ask to Configure
  if (step === 'openrouter-env' && !openrouterKey) {
    setStep('openrouter-confirm');
  }

  if (step === 'openrouter-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Would you like to configure OpenRouter?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setStep('openrouter-input');
            } else {
              setStep(replicateKey ? 'replicate-env' : 'replicate-confirm');
            }
          }}
        />
      </Box>
    );
  }

  // OpenRouter - Input API Key
  if (step === 'openrouter-input') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            OpenRouter Setup
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Get your API key from: https://openrouter.ai/settings/keys</Text>
          <Text dimColor>Note: You'll need to create an account and add credits.</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setError(null);
            }}
            placeholder="sk-or-..."
            onSubmit={() => {
              if (!apiKey) {
                setError('API key is required');
                return;
              }
              setProviders({ ...providers, openrouter: { apiKey } });
              setStep(replicateKey ? 'replicate-env' : 'replicate-confirm');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // Replicate - Environment Key Detected
  if (step === 'replicate-env' && replicateKey) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Replicate API key detected in environment. Use it?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setProviders({ ...providers, replicate: { apiKey: replicateKey } });
            }
            setStep('aws-test');
          }}
        />
      </Box>
    );
  }

  // Replicate - Ask to Configure
  if (step === 'replicate-env' && !replicateKey) {
    setStep('replicate-confirm');
  }

  if (step === 'replicate-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Would you like to configure Replicate?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setStep('replicate-input');
            } else {
              setStep('aws-test');
            }
          }}
        />
      </Box>
    );
  }

  // Replicate - Input API Key
  if (step === 'replicate-input') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Replicate Setup
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Get your API key from: https://replicate.com/account/api-tokens</Text>
          <Text dimColor>Note: You'll need to create an account and add credits.</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setError(null);
            }}
            placeholder="r8_..."
            onSubmit={() => {
              if (!apiKey) {
                setError('API key is required');
                return;
              }
              setProviders({ ...providers, replicate: { apiKey } });
              setStep('aws-test');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // AWS - Test credentials
  if (step === 'aws-test') {
    if (awsTestStatus === 'testing') {
      return (
        <Box flexDirection="column" padding={1}>
          <Box marginBottom={1}>
            <Text bold color="cyan">
              AWS Bedrock Configuration
            </Text>
          </Box>
          <Box marginBottom={1}>
            <Text color="yellow">{awsTestMessage}</Text>
          </Box>
        </Box>
      );
    }

    // Move to configure step once test is done
    if (awsTestStatus !== 'idle') {
      setStep('aws-configure');
      return null;
    }

    return null;
  }

  // AWS - Configure based on test results
  if (step === 'aws-configure') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">AWS Bedrock Configuration</Text>
        </Box>
        <Box marginBottom={1} flexDirection='column'>
          <Text dimColor>AWS Bedrock can use credentials from multiple sources:</Text>
          <Text dimColor>  - Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)</Text>
          <Text dimColor>  - Shared credentials file (~/.aws/credentials)</Text>
          <Text dimColor>  - IAM roles (when running on EC2, ECS, Lambda)</Text>
        </Box>
        {awsTestStatus === 'success' && (
          <Box marginBottom={1}>
            <Text color="green">{awsTestMessage}</Text>
          </Box>
        )}
        {awsTestStatus === 'error' && (
          <Box marginBottom={1}>
            <Text color="yellow">{awsTestMessage}</Text>
          </Box>
        )}
        <SelectInput
          items={[
            ...(awsTestStatus === 'success' || awsTestStatus === 'error'
              ? [{ label: 'Enable with auto-detected credentials', value: 'auto' }]
              : []
            ),
            { label: 'Configure with explicit environment variables', value: 'env' },
            { label: 'Test credentials again', value: 'test' },
            { label: 'Skip for now', value: 'skip' },
          ]}
          onSelect={async (item) => {
            if (item.value === 'skip') {
              setAwsTestStatus('idle');
              setAwsTestMessage('');
              setStep('custom-confirm');
              return;
            }
            if (item.value === 'test') {
              setStep('aws-test');
              setAwsTestStatus('idle');
              setAwsTestMessage('');
              return;
            }
            if (item.value === 'auto') {
              setProviders({
                ...providers,
                aws: {
                  region: process.env.AWS_REGION,
                },
              });
              setAwsTestStatus('idle');
              setAwsTestMessage('');
              setStep('custom-confirm');
              return;
            }
            if (item.value === 'env') {
              if (awsAccessKeyId && awsSecretAccessKey) {
                setProviders({
                  ...providers,
                  aws: {
                    region: awsRegion,
                    credentials: {
                      accessKeyId: awsAccessKeyId,
                      secretAccessKey: awsSecretAccessKey,
                    },
                  },
                });
              }
              setAwsTestStatus('idle');
              setAwsTestMessage('');
              setStep('custom-confirm');
            }
          }}
        />
      </Box>
    );
  }

  // AWS - Ask to Configure (fallback if needed)
  if (step === 'aws-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Would you like to configure AWS Bedrock?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setStep('aws-test');
            } else {
              setStep('custom-confirm');
            }
          }}
        />
      </Box>
    );
  }

  // Custom Provider - Ask to Configure
  if (step === 'custom-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Would you like to configure a Custom Provider? (OpenAI-compatible API)</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setStep('custom-name');
            } else {
              setStep(tavilyKey ? 'tavily-env' : 'tavily-confirm');
            }
          }}
        />
      </Box>
    );
  }

  // Custom Provider - Input Name
  if (step === 'custom-name') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Custom Provider Setup
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Enter a name for this provider (optional, e.g., "My Local LLM")</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={customName}
            onChange={(value) => {
              setCustomName(value);
              setError(null);
            }}
            placeholder="Custom Provider"
            onSubmit={() => {
              setStep('custom-base-url');
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // Custom Provider - Input Base URL
  if (step === 'custom-base-url') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Custom Provider Base URL
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Enter the base URL for the OpenAI-compatible API</Text>
          <Text dimColor>Example: https://api.example.com/v1</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={customBaseUrl}
            onChange={(value) => {
              setCustomBaseUrl(value);
              setError(null);
            }}
            placeholder="https://..."
            onSubmit={() => {
              if (!customBaseUrl.trim()) {
                setError('Base URL is required');
                return;
              }
              if (!customBaseUrl.startsWith('http://') && !customBaseUrl.startsWith('https://')) {
                setError('Base URL must start with http:// or https://');
                return;
              }
              setStep('custom-api-key');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // Custom Provider - Input API Key
  if (step === 'custom-api-key') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Custom Provider API Key
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Enter your API key for this provider</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setError(null);
            }}
            placeholder="your-api-key"
            onSubmit={() => {
              if (!apiKey.trim()) {
                setError('API key is required');
                return;
              }
              setProviders({
                ...providers,
                custom: {
                  apiKey,
                  baseUrl: customBaseUrl,
                  name: customName || undefined,
                  selectedModels: [],
                },
              });
              setStep(tavilyKey ? 'tavily-env' : 'tavily-confirm');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // Tavily - Environment Key Detected
  if (step === 'tavily-env' && tavilyKey) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Tavily API key detected in environment. Use it?</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setTavilyConfig({ apiKey: tavilyKey });
            }
            setStep('user-name');
          }}
        />
      </Box>
    );
  }

  // Tavily - Ask to Configure
  if (step === 'tavily-env' && !tavilyKey) {
    setStep('tavily-confirm');
  }

  if (step === 'tavily-confirm') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text>Would you like to configure Tavily? (Optional - enables web search)</Text>
        </Box>
        <SelectInput
          items={[
            { label: 'Yes', value: 'yes' },
            { label: 'No', value: 'no' },
          ]}
          onSelect={(item) => {
            if (item.value === 'yes') {
              setStep('tavily-input');
            } else {
              setStep('user-name');
            }
          }}
        />
      </Box>
    );
  }

  // Tavily - Input API Key
  if (step === 'tavily-input') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Tavily Setup
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>Get your API key from: https://tavily.com</Text>
          <Text dimColor>Note: Tavily provides web search capabilities for the Internet agent.</Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={apiKey}
            onChange={(value) => {
              setApiKey(value);
              setError(null);
            }}
            placeholder="tvly-..."
            onSubmit={() => {
              if (!apiKey) {
                setError('API key is required');
                return;
              }
              setTavilyConfig({ apiKey });
              setStep('user-name');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // User Name
  if (step === 'user-name') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            What is your name?
          </Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={name}
            onChange={(value) => {
              setName(value);
              setError(null);
            }}
            placeholder="Your name"
            onSubmit={() => {
              if (!name.trim()) {
                setError('Name is required');
                return;
              }
              setStep('user-pronouns');
            }}
          />
        </Box>
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <Text dimColor>Enter to continue</Text>
        </Box>
      </Box>
    );
  }

  // User Pronouns
  if (step === 'user-pronouns') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            What are your pronouns? (optional)
          </Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={pronouns}
            onChange={setPronouns}
            placeholder="e.g., he/him, she/her, they/them"
            onSubmit={() => {
              setStep('user-memory');
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to continue, ESC to skip</Text>
        </Box>
      </Box>
    );
  }

  // User Memory
  if (step === 'user-memory') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="cyan">
            Is there anything we should always remember when talking to you? (optional)
          </Text>
        </Box>
        <Box>
          <Text color="cyan">▶ </Text>
          <TextInput
            value={memory}
            onChange={setMemory}
            placeholder="e.g., I prefer concise responses"
            onSubmit={async () => {
              // Create config file
              const config = new ConfigFile();
              await config.save((data) => {
                data.user.name = name;
                data.user.pronouns = pronouns;
                if (memory.trim()) {
                  data.user.memory.push({
                    text: memory,
                    created: Date.now(),
                  });
                }
                data.providers = providers;
                data.tavily = tavilyConfig;
              });

              // Create knowledge file
              const knowledge = new KnowledgeFile();
              await knowledge.save(() => {
                // Initialize with empty knowledge
              });

              setStep('complete');

              // Small delay then call onComplete
              setTimeout(() => {
                onComplete(config);
              }, 1000);
            }}
          />
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to complete setup</Text>
        </Box>
      </Box>
    );
  }

  // Complete
  if (step === 'complete') {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Text bold color="green">
            ✓ Setup complete!
          </Text>
        </Box>
        <Box>
          <Text>Welcome, {name}! Cletus is ready to help you.</Text>
        </Box>
      </Box>
    );
  }

  return null;
};
