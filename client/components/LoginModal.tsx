import React, { useState } from 'react';
import { apiUrl } from '../config';

interface LoginModalProps {
  isOpen: boolean;
  onClose: () => void;
  onLoginSuccess: (user: any) => void;
  onSwitchToRegister: () => void;
}

export const LoginModal: React.FC<LoginModalProps> = ({ isOpen, onClose, onLoginSuccess, onSwitchToRegister }) => {
  
  const [step, setStep] = useState<'credentials' | 'code'>('credentials');
  const [userId, setUserId] = useState<number | null>(null);
  
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    code: ''
  });
  
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  if (!isOpen) return null;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleCredentialsSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    setMessage('');

    try {
      const response = await fetch(apiUrl('/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: formData.email, password: formData.password }),
      });

      const data = await response.json();

      if (response.ok && data.step === 'code_required') {
        setStatus('idle');
        setUserId(data.userId);
        setStep('code');
        setMessage('Enter the code received via email.');
      } else {
        setStatus('error');
        setMessage(data.error || 'Authentication error.');
      }
    } catch (error) {
      setStatus('error');
      setMessage('Connection error.');
    }
  };

  const handleCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatus('loading');
    
    try {
      const response = await fetch(apiUrl('/verify-code'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Important pentru a seta cookie-ul
        body: JSON.stringify({ userId, code: formData.code }),
      });

      const data = await response.json();

      if (response.ok) {
        setStatus('success');
        setMessage('Authentication successful!');
        setTimeout(() => {
          onLoginSuccess(data.user);
          onClose();
          // Reset
          setStep('credentials');
          setFormData({ email: '', password: '', code: '' });
          setStatus('idle');
        }, 1500);
      } else {
        setStatus('error');
        setMessage(data.error || 'Incorrect code.');
      }
    } catch (error) {
      setStatus('error');
      setMessage('Connection error.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-3xl p-8 w-full max-w-md shadow-2xl relative">
        <button 
          onClick={onClose}
          className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
        >
          <span className="material-icons">close</span>
        </button>

        <h2 className="text-2xl font-bold mb-6 text-gray-900 dark:text-white text-center">
          {step === 'credentials' ? 'Authentication' : 'Verify Code'}
        </h2>

        {status === 'success' ? (
          <div className="text-green-600 text-center font-bold text-lg p-4">
            {message}
          </div>
        ) : (
          <form id="login-form" onSubmit={step === 'credentials' ? handleCredentialsSubmit : handleCodeSubmit} className="space-y-4">
            {message && status !== 'idle' && (
              <div className={`text-sm text-center p-2 rounded-lg ${status === 'error' ? 'text-red-500 bg-red-50' : 'text-blue-500 bg-blue-50'}`}>
                {message}
              </div>
            )}
            
            {step === 'credentials' ? (
              <>
                <div>
                  <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                  <input
                    id="login-email"
                    type="email"
                    name="email"
                    autoComplete="username"
                    inputMode="email"
                    value={formData.email}
                    onChange={handleChange}
                    required
                    className="w-full px-4 py-2 rounded-xl border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none"
                    placeholder="email@example.com"
                  />
                </div>
                <div>
                  <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Password</label>
                  <div className="relative">
                    <input
                      id="login-password"
                      type={showPassword ? "text" : "password"}
                      name="password"
                      autoComplete="current-password"
                      value={formData.password}
                      onChange={handleChange}
                      required
                      className="w-full px-4 py-2 pr-10 rounded-xl border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none"
                      placeholder="******"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                    >
                      <span className="material-icons text-xl">
                        {showPassword ? 'visibility_off' : 'visibility'}
                      </span>
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div>
                <label htmlFor="login-code" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Code received on Email</label>
                <input
                  id="login-code"
                  type="text"
                  name="code"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  value={formData.code}
                  onChange={handleChange}
                  required
                  maxLength={6}
                  className="w-full px-4 py-3 text-center text-2xl tracking-widest rounded-xl border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-primary outline-none"
                  placeholder="123456"
                />
                <p className="text-xs text-gray-500 text-center mt-2">Check Spam folder too.</p>
              </div>
            )}

            <button
              type="submit"
              disabled={status === 'loading'}
              className="w-full bg-primary hover:bg-primary-dark text-white font-bold py-3 rounded-xl shadow-lg mt-4 transition-all disabled:opacity-70"
            >
              {status === 'loading' ? 'Checking...' : (step === 'credentials' ? 'Continue' : 'Login')}
            </button>

            {step === 'credentials' && (
              <div className="text-center mt-4 pt-2 border-t border-gray-100 dark:border-gray-700">
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={onSwitchToRegister}
                    className="text-primary hover:underline font-bold"
                  >
                    Register
                  </button>
                </p>
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
};
