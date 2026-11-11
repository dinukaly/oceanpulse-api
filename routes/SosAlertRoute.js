import express from 'express';
import SosAlertController from '../controller/SosAlertController.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';

const router = express.Router();
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Fisherman endpoints
router.post('/sos', authenticateToken, SosAlertController.saveSosMessage);
router.get('/active', authenticateToken, SosAlertController.getActiveSosAlerts);
router.get('/current', authenticateToken, SosAlertController.getCurrentReceipt);
router.post('/cancel', authenticateToken, SosAlertController.cancelActiveAlert);

// Coast Guard Responder endpoints (enforced role: coastguard)
router.get('/responder/alerts', authenticateToken, requireRole('coastguard'), SosAlertController.getResponderAlerts);
router.get('/responder/alerts/:alertId', authenticateToken, requireRole('coastguard'), SosAlertController.getResponderAlertById);
router.patch('/responder/alerts/:alertId/status', authenticateToken, requireRole('coastguard'), SosAlertController.updateAlertStatus);
router.post('/responder/alerts/:alertId/notes', authenticateToken, requireRole('coastguard'), SosAlertController.addAlertNote);
router.get('/responder/stats', authenticateToken, requireRole('coastguard'), SosAlertController.getResponderStats);

// Legacy responder status route
router.patch('/:messageId/status', authenticateToken, SosAlertController.updateSosStatus);

export default router;
