import { Schema } from "effect"

export const TeamMember = Schema.Struct({
  name: Schema.String,
  kind: Schema.Literal("iam-user", "trusted-principal", "cf-service-token"),
  arn: Schema.String,
  createdAt: Schema.optional(Schema.String),
})
export type TeamMember = typeof TeamMember.Type
