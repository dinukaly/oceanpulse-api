import sgMail from '@sendgrid/mail';
import axios from 'axios';
import { config } from '../config/env.js';
import { AppError } from '../middleware/errorHandler.js';

export const requireEmailDelivery = () => {
  if (config.devLogVerificationCodes) return;
  const configured = config.emailProvider === 'resend'
    ? config.resendApiKey && config.resendFromEmail
    : config.sendgridApiKey && config.sendgridFromEmail;
  if (!configured) {
    throw new AppError('Verification email is not configured', 503);
  }
};

export const sendVerificationEmail = async (email, code, purpose) => {
  requireEmailDelivery();
  if (config.devLogVerificationCodes) {
    console.info(`[DEV ONLY] OceanPulse ${purpose} verification code for ${email}: ${code}`);
    return;
  }
  try {
    const message = {
      to: email,
      from: config.emailProvider === 'resend' ? config.resendFromEmail : config.sendgridFromEmail,
      subject: purpose === 'account' ? 'Verify your OceanPulse account' : 'Reset your OceanPulse password',
      text: `Your OceanPulse verification code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    };
    if (config.emailProvider === 'resend') {
      const response = await axios.post('https://api.resend.com/emails', {
        ...message,
        to: [email],
      }, {
        headers: { Authorization: `Bearer ${config.resendApiKey}` },
        timeout: 10000,
        maxRedirects: 0,
      });
      if (!response.data?.id) throw new Error('Email provider did not accept the message');
    } else {
      sgMail.setApiKey(config.sendgridApiKey);
      await sgMail.send(message);
    }
  } catch (error) {
    throw new AppError('Verification email could not be delivered', 503);
  }
};
