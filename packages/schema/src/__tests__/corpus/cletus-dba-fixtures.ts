/** The tables cletus-dba's tests and the planning bench use. */
import type { TypeDefinition } from './cletus-tools';


const t = (name: string, fields: string[]): TypeDefinition => ({
  name, friendlyName: name[0]!.toUpperCase() + name.slice(1), knowledgeTemplate: '',
  fields: fields.map((f) => ({ name: f, friendlyName: f, type: 'string' })),
});
/** The tables the examples use. */
export const TYPES: TypeDefinition[] = [
  t('users', ['name', 'email', 'age', 'active', 'lastLogin', 'firstName', 'lastName', 'emailDomain', 'deactivatedAt']),
  t('orders', ['userId', 'total']),
  t('products', ['category', 'price']),
  t('archive_users', ['name', 'email']),
  t('temp_data', []),
  t('transactions', ['amount']),
  t('projects', ['name', 'parentId', 'status', 'assignedTo']),
];
