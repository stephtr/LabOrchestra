import { checkAccessToken } from '@/lib/controlHub';
import {
	Button,
	Input,
	Modal,
	ModalBody,
	ModalContent,
	ModalFooter,
	ModalHeader,
} from '@heroui/react';
import { useState } from 'react';

export function AccessTokenOverlay() {
	const [accessTokenValue, setAccessTokenValue] = useState('');
	const [isLoading, setIsLoading] = useState(false);

	const handleLogin = async () => {
		if (!accessTokenValue) return;
		setIsLoading(true);
		if (!(await checkAccessToken(accessTokenValue))) {
			// eslint-disable-next-line no-alert
			alert('Invalid access token');
			setIsLoading(false);
			return;
		}
		setIsLoading(false);
		localStorage.setItem('accessToken', accessTokenValue);
		window.location.reload();
	};

	return (
		<Modal
			isOpen
			isDismissable={false}
			isKeyboardDismissDisabled
			hideCloseButton
		>
			<ModalContent>
				<ModalHeader>Access Token required</ModalHeader>
				<ModalBody>
					<p>Please enter your access token to continue:</p>
					<Input
						type="text"
						placeholder="Access Token"
						value={accessTokenValue}
						isDisabled={isLoading}
						onChange={(e) => setAccessTokenValue(e.target.value)}
					/>
				</ModalBody>
				<ModalFooter>
					<Button
						color="primary"
						onPress={handleLogin}
						isDisabled={isLoading}
					>
						Login
					</Button>
				</ModalFooter>
			</ModalContent>
		</Modal>
	);
}
