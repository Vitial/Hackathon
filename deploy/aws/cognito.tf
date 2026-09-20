# ------------------------------------------------------------------ cognito --
# Production identity for the public sign-up funnel (src/console/cognito.ts).
# The console calls SignUp/InitiateAuth server-side with the ECS task role
# (SigV4, no SDK, no client secret); the ALB and the app's own session cookie
# are unchanged. Local dev and self-hosted runs never see any of this — the
# integration is env-gated and off unless VITAL_COGNITO_* is set.

resource "aws_cognito_user_pool" "public" {
  name                = "${local.name}-public"
  username_attributes = ["email"]
  # What becomes verified *when* a confirmation code is confirmed. It does not
  # confirm a public SignUp on its own: the deployed pool answers
  # UserConfirmed: false and mails a code (verified against this pool), so the
  # console collects that code on /verify-email via cognitoConfirmSignUp and
  # the address is verified at that moment. No pool argument skips the step —
  # the alternatives are admin-created accounts or nothing. The SignUp API's
  # `email_verified` attribute is admin-only and is deliberately not sent (see
  # src/console/cognito.ts).
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"

  # Mirrors MIN_PASSWORD_LENGTH in src/core/auth.ts (12) so the pool never
  # accepts what the console would reject, or vice versa.
  password_policy {
    minimum_length    = 12
    require_uppercase = true
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
  }

  # The funnel signs users up through the SignUp API. With this true the
  # API refuses every non-admin call outright, so it must be false; the
  # hosted self-service UI stays unused (no domain is attached).
  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  # A user pool is an account registry: destroying it invalidates every
  # production account, so removal must be a deliberate operator act
  # (destroy the guard first), never an accident of `terraform destroy`.
  lifecycle {
    prevent_destroy = true
  }

  # Recovery by verified email only. The argument takes the provider's own
  # vocabulary (`verified_email`), not the API's uppercase form, and the
  # account must be able to recover without an operator: the funnel is public
  # and there is no support desk behind it.
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  email_configuration {
    email_sending_account = "COGNITO_DEFAULT"
  }

  tags = { Project = var.project }
}

resource "aws_cognito_user_pool_client" "funnel" {
  name         = "${local.name}-funnel"
  user_pool_id = aws_cognito_user_pool.public.id

  # Server-side caller: no secret to hide, password auth flow only.
  generate_secret     = false
  explicit_auth_flows = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  # LEGACY on purpose: with ENABLED, USER_PASSWORD_AUTH for a non-existent
  # user answers NotAuthorizedException instead of UserNotFoundException —
  # and the console's local-login fallback (bootstrap owner, invitees) keys
  # off UserNotFound. The sign-up API's duplicate answer is already explicit
  # by design ("that email already has an account"), so hiding existence at
  # login would buy inconsistency, not safety.
  prevent_user_existence_errors = "LEGACY"

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30
  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }

  # No tags here: `aws_cognito_user_pool_client` does not accept them (the pool
  # above does). Cost allocation reads the pool's tags either way.
}
