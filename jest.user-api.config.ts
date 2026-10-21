import type { Config } from 'jest';
const config: Config = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  testMatch: ['<rootDir>/tests/auth/**/*.spec.ts'],
  collectCoverageFrom: [
    'src/auth/**/*.ts',
    'src/users/**/*.ts',
    'src/config/auth.config.ts',
    '!src/**/contracts/**',
    '!src/**/*.module.ts',
  ],
  coverageDirectory: './coverage/user-api',
  coverageReporters: ['text', 'json-summary', 'lcov'],
};
export default config;
