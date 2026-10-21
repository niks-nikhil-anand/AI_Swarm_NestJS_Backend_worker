import { z } from 'zod';
import { CreateUserSchema } from '../../users/contracts/user-request';
export const RegisterSchema = CreateUserSchema;
export const LoginSchema = CreateUserSchema.pick({
  email: true,
  password: true,
});
export const UpdateMeSchema = CreateUserSchema.omit({ password: true })
  .partial()
  .extend({
    newPassword: z.string().min(8).max(128).optional(),
    currentPassword: z.string().min(1).max(128).optional(),
  })
  .strict()
  .refine(
    (value) =>
      ['email', 'name', 'avatar', 'newPassword'].some(
        (k) => value[k as keyof typeof value] !== undefined,
      ),
    'Provide an update',
  );
export const DeleteMeSchema = z
  .object({ currentPassword: z.string().min(1).max(128) })
  .strict();
export type UpdateMeInput = z.infer<typeof UpdateMeSchema>;
