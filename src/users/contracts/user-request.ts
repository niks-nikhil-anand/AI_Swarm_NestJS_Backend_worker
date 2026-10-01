import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(128);
const name = z.string().trim().min(1).max(100).nullable().optional();
const avatar = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => /^https?:\/\//i.test(value),
    'Avatar must be an HTTP or HTTPS URL',
  )
  .nullable()
  .optional();

export const CreateUserSchema = z
  .object({ email, password, name, avatar })
  .strict();
export const UpdateUserSchema = CreateUserSchema.partial().refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  'Provide at least one field to update',
);
export const UserIdSchema = z.string().trim().min(1).max(100);
export const UserListSchema = z
  .object({
    skip: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(1000000))
      .default(0),
    take: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(100))
      .default(20),
  })
  .strict();

export type CreateUserInput = z.infer<typeof CreateUserSchema>;
export type UpdateUserInput = z.infer<typeof UpdateUserSchema>;
export type UserListInput = z.infer<typeof UserListSchema>;
